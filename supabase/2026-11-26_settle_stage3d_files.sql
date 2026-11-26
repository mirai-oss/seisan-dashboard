-- 移行 段階3-4（2026-11-26）: 添付と発行PDFの置き場を Supabase にする。
-- 切り替えまでは、Google ドライブから写すだけ（ドライブは消さない・変えない）。画面からの追加・削除は mode='live' まで断る。
begin;
insert into storage.buckets (id, name, public, file_size_limit) values ('settle-files', 'settle-files', false, 31457280) on conflict (id) do nothing;
create table if not exists public.settle_attachments (
  id bigint generated always as identity primary key,
  store_key text not null, month text not null, file_name text not null, storage_path text not null unique,
  mime text, size_bytes bigint, drive_id text unique, uploaded_by text,
  created_at timestamptz not null default now(), deleted_at timestamptz, deleted_by text);
create index if not exists settle_attachments_store_month on public.settle_attachments (store_key, month);
alter table public.settle_attachments enable row level security;
revoke all on public.settle_attachments from public, anon, authenticated;

-- 見てよい店舗か（画面の表示と同じ決まり）
create or replace function public.settle_can_view(actor jsonb, p_key text) returns boolean
language sql immutable set search_path = '' as $$
  select actor->>'role' = '本部' or public.settle_norm(actor->>'storesRaw') in ('全店','')
      or p_key in (select public.settle_norm(x) from regexp_split_to_table(coalesce(actor->>'storesRaw',''), '[,、，]') x) $$;

-- 一覧（null = ログインが無い）
create or replace function public.settle_file_list(p_token text, p_store text, p_month text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare u jsonb := public.settle_whoami(p_token); k text;
begin
  if u is null then return null; end if;
  k := public.settle_key_of(p_store);
  if not public.settle_can_view(u, k) then raise exception 'この店舗の閲覧権限がありません'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', a.id::text, 'name', a.file_name, 'path', a.storage_path,
            'date', to_char(a.created_at at time zone 'Asia/Tokyo', 'FMMM/FMDD HH24:MI')) order by a.file_name, a.id), '[]')
          from public.settle_attachments a where a.store_key = k and a.month = p_month and a.deleted_at is null);
end $$;

-- 1件（id か、ドライブの時のファイルID）
create or replace function public.settle_file_get(p_token text, p_file text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare u jsonb := public.settle_whoami(p_token); a public.settle_attachments;
begin
  if u is null then return null; end if;
  select * into a from public.settle_attachments x where (x.drive_id = p_file or x.id::text = p_file) and x.deleted_at is null limit 1;
  if a.id is null then raise exception 'ファイルが見つかりません'; end if;
  if not public.settle_can_view(u, a.store_key) then raise exception 'この店舗の閲覧権限がありません'; end if;
  return jsonb_build_object('name', a.file_name, 'path', a.storage_path);
end $$;

-- 画面から追加する前の確認（本部以上・切り替え後・振込済みでない）。同じ名前の一覧も返す
create or replace function public.settle_file_target(actor jsonb, p_store text, p_month text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  perform public.settle_require_live(); perform public.settle_require_hq(actor);
  k := public.settle_key_of(p_store);
  if coalesce(p_month,'') !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception '対象月の形式が不正です'; end if;
  if not public.settle_can_view(actor, k) then raise exception 'この店舗の権限がありません'; end if;
  perform public.settle_require_unlocked(actor, k, p_month);
  return jsonb_build_object('key', k, 'names', (select coalesce(jsonb_agg(a.file_name), '[]') from public.settle_attachments a where a.store_key = k and a.month = p_month and a.deleted_at is null));
end $$;

create or replace function public.settle_file_delete(actor jsonb, p_store text, p_month text, p_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t jsonb; n text;
begin
  t := public.settle_file_target(actor, p_store, p_month);
  update public.settle_attachments set deleted_at = now(), deleted_by = actor->>'name'
   where id::text = p_id and store_key = t->>'key' and month = p_month and deleted_at is null returning file_name into n;
  if n is null then raise exception 'この店舗・月にそのファイルは見つかりません（すでに削除された可能性があります）'; end if;
  perform public.settle_log(actor, '添付削除', t->>'key', p_month, jsonb_build_object('id', p_id, 'name', n), null);
  return jsonb_build_object('ok', true, 'name', n);
end $$;

-- ドライブからの写し（GAS用・切り替え前だけ）
create or replace function public.settle_drive_ids() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(drive_id), '[]') from public.settle_attachments where drive_id is not null and deleted_at is null $$;

create or replace function public.settle_file_register(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if (select value from public.settle_config where key = 'mode') = 'live' then raise exception '切り替え後のため、ドライブからは写せません'; end if;
  insert into public.settle_attachments (store_key, month, file_name, storage_path, mime, size_bytes, drive_id, uploaded_by, created_at)
  values (public.settle_norm(p->>'store'), p->>'month', p->>'name', p->>'path', p->>'mime', (p->>'size')::bigint, p->>'driveId', 'ドライブから写し',
          coalesce((p->>'createdAt')::timestamptz, now()))
  on conflict (drive_id) do update set store_key = excluded.store_key, month = excluded.month, file_name = excluded.file_name,
    storage_path = excluded.storage_path, mime = excluded.mime, size_bytes = excluded.size_bytes, deleted_at = null, deleted_by = null;
end $$;

-- ドライブで消された（または移された）ファイルは、写し側でも消した印を付ける
create or replace function public.settle_file_prune(p_ids jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if (select value from public.settle_config where key = 'mode') = 'live' then raise exception '切り替え後のため、変更できません'; end if;
  if coalesce(jsonb_array_length(p_ids),0) = 0 then return 0; end if;
  update public.settle_attachments set deleted_at = now(), deleted_by = 'ドライブで削除'
   where drive_id is not null and deleted_at is null and not (p_ids ? drive_id);
  get diagnostics n = row_count; return n;
end $$;

revoke all on function public.settle_can_view(jsonb, text) from public, anon, authenticated;
grant execute on function public.settle_can_view(jsonb, text) to service_role;
revoke all on function public.settle_file_list(text, text, text) from public, anon, authenticated;
grant execute on function public.settle_file_list(text, text, text) to service_role;
revoke all on function public.settle_file_get(text, text) from public, anon, authenticated;
grant execute on function public.settle_file_get(text, text) to service_role;
revoke all on function public.settle_file_target(jsonb, text, text) from public, anon, authenticated;
grant execute on function public.settle_file_target(jsonb, text, text) to service_role;
revoke all on function public.settle_file_delete(jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.settle_file_delete(jsonb, text, text, text) to service_role;
revoke all on function public.settle_drive_ids() from public, anon, authenticated;
grant execute on function public.settle_drive_ids() to service_role;
revoke all on function public.settle_file_register(jsonb) from public, anon, authenticated;
grant execute on function public.settle_file_register(jsonb) to service_role;
revoke all on function public.settle_file_prune(jsonb) from public, anon, authenticated;
grant execute on function public.settle_file_prune(jsonb) to service_role;
commit;

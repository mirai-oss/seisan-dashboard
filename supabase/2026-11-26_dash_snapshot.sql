-- 精算ダッシュボード「画面の写し」(2026-11-26)
-- ログイン直後に前回の画面データをすぐ表示し、裏でGASから最新を取り直すための置き場。
-- 見える範囲は GAS が決める（権限＋担当店舗ごとの scope_key）。画面側は自分のログイン用トークンでしか読めない。
-- 写しは正本ではない（消しても、次に画面を開けば作り直される）。
--
-- 元に戻す:
--   drop function if exists public.sd_dash_put(jsonb), public.sd_dash_get(text, text),
--     public.sd_dash_logout(text), public.sd_dash_revoke_all();
--   drop table if exists public.sd_dash_grant, public.sd_dash_snapshot;

begin;

create table if not exists public.sd_dash_grant (
  token_hash text primary key,              -- ログイン用トークンのSHA-256（トークンそのものは置かない）
  scope_key  text not null,                 -- 見える範囲（権限＋担当店舗）のハッシュ
  user_name  text not null default '',
  user_role  text not null default '',
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.sd_dash_snapshot (
  scope_key text not null,
  month_key text not null,                  -- 'YYYY-MM'
  data      jsonb not null,
  saved_at  timestamptz not null default now(),
  primary key (scope_key, month_key)
);

-- 直接の読み書きは一切させない（下の関数だけを入口にする）
alter table public.sd_dash_grant    enable row level security;
alter table public.sd_dash_snapshot enable row level security;
revoke all on public.sd_dash_grant    from public, anon, authenticated;
revoke all on public.sd_dash_snapshot from public, anon, authenticated;

-- GASから: 閲覧できる権利の登録・延長（month と data があれば写しも保存）
create or replace function public.sd_dash_put(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.sd_dash_grant (token_hash, scope_key, user_name, user_role, expires_at, updated_at)
  values (p->>'token_hash', p->>'scope_key', coalesce(p->>'user_name',''), coalesce(p->>'user_role',''),
          now() + interval '14 days', now())
  on conflict (token_hash) do update
    set scope_key = excluded.scope_key, user_name = excluded.user_name, user_role = excluded.user_role,
        expires_at = excluded.expires_at, updated_at = now();

  if coalesce(p->>'month_key','') ~ '^\d{4}-\d{2}$' and jsonb_typeof(p->'data') = 'object' then
    insert into public.sd_dash_snapshot (scope_key, month_key, data, saved_at)
    values (p->>'scope_key', p->>'month_key', p->'data', now())
    on conflict (scope_key, month_key) do update set data = excluded.data, saved_at = now();
  end if;

  delete from public.sd_dash_grant where expires_at < now();
end $$;

-- 画面から: 自分のトークンに許された範囲の写しを1件返す（無ければ null）
create or replace function public.sd_dash_get(p_token text, p_month text default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
           'data', jsonb_set(s.data, '{user}', jsonb_build_object('name', g.user_name, 'role', g.user_role)),
           'savedAt', s.saved_at)
  from public.sd_dash_grant g
  join public.sd_dash_snapshot s
    on s.scope_key = g.scope_key
   and s.month_key = coalesce(p_month,
         to_char((now() at time zone 'Asia/Tokyo') - interval '1 month', 'YYYY-MM'))
  where length(coalesce(p_token,'')) >= 32
    and g.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
    and g.expires_at > now()
    and s.saved_at > now() - interval '14 days'
$$;

-- 画面から: ログアウトしたら、自分の閲覧の権利を消す
create or replace function public.sd_dash_logout(p_token text) returns void
language sql security definer set search_path = '' as $$
  delete from public.sd_dash_grant
  where token_hash = encode(sha256(convert_to(coalesce(p_token,''), 'UTF8')), 'hex')
$$;

-- GASから: アカウント設定を変えたら、全員分の権利と写しを消す（次に開いたときに作り直す）
create or replace function public.sd_dash_revoke_all() returns void
language sql security definer set search_path = '' as $$
  delete from public.sd_dash_grant where true;
  delete from public.sd_dash_snapshot where true;
$$;

revoke all on function public.sd_dash_put(jsonb)        from public, anon, authenticated;
revoke all on function public.sd_dash_get(text, text)   from public, anon, authenticated;
revoke all on function public.sd_dash_logout(text)      from public, anon, authenticated;
revoke all on function public.sd_dash_revoke_all()      from public, anon, authenticated;
grant execute on function public.sd_dash_put(jsonb)      to service_role;
grant execute on function public.sd_dash_revoke_all()    to service_role;
grant execute on function public.sd_dash_get(text, text) to anon, authenticated;
grant execute on function public.sd_dash_logout(text)    to anon, authenticated;

commit;

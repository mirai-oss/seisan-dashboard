-- 移行 段階3-6（2026-11-26）: 外の仕組み（請求書・経営ダッシュボード）の受け口で使う表。切り替えの時に、写したシートから中身を入れる。
begin;
create table if not exists public.settle_pl_mappings (
  id bigint generated always as identity primary key, mf_account text not null, mf_sub text not null default '', vendor text not null default '',
  on_off boolean not null default true, account text not null default '', updated_at text, updated_by text, unique (mf_account, mf_sub, vendor));
create table if not exists public.settle_pl_sync_logs (
  store text not null, month text not null, ok boolean not null, last_ok_at text not null default '', error text not null default '', last_attempt_at text,
  primary key (store, month));
alter table public.settle_pl_mappings enable row level security;
alter table public.settle_pl_sync_logs enable row level security;
revoke all on public.settle_pl_mappings, public.settle_pl_sync_logs from public, anon, authenticated;

create or replace function public.settle_load_pl() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.settle_pl_mappings where true;
  insert into public.settle_pl_mappings (mf_account, mf_sub, vendor, on_off, account, updated_at, updated_by)
  select distinct on (btrim(cells->>0), btrim(coalesce(cells->>1,'')), btrim(coalesce(cells->>2,'')))
    btrim(cells->>0), btrim(coalesce(cells->>1,'')), btrim(coalesce(cells->>2,'')), upper(btrim(coalesce(cells->>3,''))) <> 'OFF',
    btrim(coalesce(cells->>4,'')), cells->>5, cells->>6
  from public.settle_sheet_rows where sheet like 'PLマッピング%' and row_no > 1 and btrim(coalesce(cells->>0,'')) <> ''
  order by btrim(cells->>0), btrim(coalesce(cells->>1,'')), btrim(coalesce(cells->>2,'')), row_no;
  -- 対応表のシートがまだ無い（または空の）場合は、GASが最初に作るのと同じ初期の対応を入れる
  if not exists (select 1 from public.settle_pl_mappings) then
    insert into public.settle_pl_mappings (mf_account, on_off, account, updated_by) values
      ('仕入高',true,'仕入（食材・飲料）','(初期シード)'), ('地代家賃',true,'家賃','(初期シード)'), ('備品・消耗品費',true,'消耗品・備品費','(初期シード)'),
      ('退職金',true,'退職金等','(初期シード)'), ('研修採用費',true,'採用教育費','(初期シード)'), ('雑給',false,'','(初期シード)'),
      ('給料手当',false,'','(初期シード)'), ('賞与',false,'','(初期シード)'), ('支払利息',false,'','(初期シード)');
  end if;
  delete from public.settle_pl_sync_logs where true;
  insert into public.settle_pl_sync_logs (store, month, ok, last_ok_at, error, last_attempt_at)
  select distinct on (btrim(cells->>0), btrim(cells->>1)) btrim(cells->>0), btrim(cells->>1), cells->>2 = 'OK', coalesce(cells->>3,''), coalesce(cells->>4,''), cells->>5
  from public.settle_sheet_rows where sheet like 'PL反映ログ%' and row_no > 1 and btrim(coalesce(cells->>0,'')) <> ''
  order by btrim(cells->>0), btrim(cells->>1), row_no;
  return jsonb_build_object('mappings', (select count(*) from public.settle_pl_mappings), 'logs', (select count(*) from public.settle_pl_sync_logs));
end $$;

create or replace function public.settle_system_data() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'stores',   (select coalesce(jsonb_agg(to_jsonb(t) order by t.sort_order), '[]') from public.settle_stores t),
    'terms',    (select coalesce(jsonb_agg(to_jsonb(t) order by t.store_key, t.from_month), '[]') from public.settle_store_terms t),
    'periods',  (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.settle_store_periods t),
    'lines',    (select coalesce(jsonb_agg(to_jsonb(t) order by t.store_key, t.legacy_row nulls last, t.id), '[]') from public.settle_lines t where t.deleted_at is null),
    'payments', (select coalesce(jsonb_agg(to_jsonb(t) order by t.seq), '[]') from public.settle_payment_events t),
    'logs',     (select coalesce(jsonb_agg(to_jsonb(t) order by t.seq), '[]') from public.settle_issue_logs t),
    'sales',    (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.settle_sales_monthly t),
    'corpRows', '[]'::jsonb,
    'settings', coalesce((select settings from public.settle_import_runs order by id desc limit 1), '{}'),
    'mappings', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.settle_pl_mappings t),
    'plLogs',   (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.settle_pl_sync_logs t),
    'mode', coalesce((select value from public.settle_config where key = 'mode'), 'copy'))
$$;

create or replace function public.settle_set_mode(p_mode text, p_by text) returns text
language plpgsql security definer set search_path = '' as $$
declare was text;
begin
  if p_mode not in ('copy','live') then raise exception 'mode は copy か live'; end if;
  select value into was from public.settle_config where key = 'mode' for update;
  if p_mode = 'live' and was <> 'live' then perform public.settle_load_pl(); end if;
  update public.settle_config set value = p_mode where key = 'mode';
  insert into public.settle_audit (actor, action, after) values (p_by, '切り替え', jsonb_build_object('mode', p_mode));
  return p_mode;
end $$;

revoke all on function public.settle_load_pl(), public.settle_system_data(), public.settle_set_mode(text, text) from public, anon, authenticated;
grant execute on function public.settle_load_pl(), public.settle_system_data(), public.settle_set_mode(text, text) to service_role;
commit;

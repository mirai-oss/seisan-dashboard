-- 移行 段階2（試験表示）: ログイン中の本人だけが、写したデータを読むための関数
-- ログインの確認は、今のダッシュボードが発行したログイン（sd_dash_grant と ds_sessions の両方にあるもの）だけを通す。
-- 呼べるのは Supabase の関数 seisan-api（service_role）だけ。読むだけで、何も書き換えない。
-- 元に戻す: drop function public.settle_read(text);
begin;
create or replace function public.settle_read(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with g as (
    select user_role from public.sd_dash_grant
    where length(coalesce(p_token,'')) >= 32
      and token_hash = encode(sha256(convert_to(p_token,'UTF8')),'hex') and expires_at > now()),
  s as (
    select x.sess from public.ds_sessions x, g
    where x.token = p_token and x.expires_at > now() and x.sess ? 'storesRaw' and x.sess->>'role' = g.user_role),
  r as (select imported_at from public.settle_import_runs order by id desc limit 1)
  select jsonb_build_object(
    'user', jsonb_build_object('name', s.sess->>'name', 'role', s.sess->>'role', 'storesRaw', s.sess->>'storesRaw'),
    'importedAt', r.imported_at,
    'data', jsonb_build_object(
      'stores',   (select coalesce(jsonb_agg(to_jsonb(t) - 'mail'), '[]') from public.settle_stores t),
      'periods',  (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.settle_store_periods t),
      'lines',    (select coalesce(jsonb_agg(to_jsonb(t) order by t.store_key, t.legacy_row), '[]') from public.settle_lines t),
      'payments', (select coalesce(jsonb_agg(to_jsonb(t) order by t.seq), '[]') from public.settle_payment_events t),
      'logs',     (select coalesce(jsonb_agg(to_jsonb(t) order by t.seq), '[]') from public.settle_issue_logs t),
      'sales',    (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.settle_sales_monthly t),
      'corpRows', (select coalesce(jsonb_agg(t.cells order by t.row_no), '[]') from public.settle_sheet_rows t where t.sheet like '法人設定%')))
  from s, r
$$;
revoke all on function public.settle_read(text) from public, anon, authenticated;
grant execute on function public.settle_read(text) to service_role;
commit;

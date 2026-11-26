-- 移行 段階3-2（2026-11-26）: ログインと利用申請。切り替えまでは、写したアカウントでの「ログインの確認」だけに使う。
-- 今の画面のログインには影響しない。
begin;
create table if not exists public.settle_accounts (
  login_id text primary key, pw_hash text not null default '', name text not null default '', role text not null,
  stores_raw text not null default '', enabled boolean not null default true, email text not null default '', sort_order int not null default 9999);
create table if not exists public.settle_sessions (
  token_hash text primary key, login_id text not null, created_at timestamptz not null default now(), expires_at timestamptz not null);
create table if not exists public.settle_login_fails (key text primary key, fails int not null, until timestamptz not null);
create table if not exists public.settle_auth_logs (id bigint generated always as identity primary key, at timestamptz not null default now(), event text, who text, result text);
create table if not exists public.settle_reset_tokens (token_hash text primary key, login_id text not null, expires_at timestamptz not null);
create table if not exists public.settle_access_requests (
  id text primary key, at timestamptz not null default now(), at_text text, email text, name text, company text, status text,
  handled_by text, handled_at timestamptz, created_id text, note text, base_id text);
do $$
declare t text;
begin
  foreach t in array array['settle_accounts','settle_sessions','settle_login_fails','settle_auth_logs','settle_reset_tokens','settle_access_requests'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;

create or replace function public.settle_add_fail(p_key text, p_minutes int) returns void
language sql security definer set search_path = '' as $$
  insert into public.settle_login_fails as f (key, fails, until) values (p_key, 1, now() + make_interval(mins => p_minutes))
  on conflict (key) do update set fails = case when f.until > now() then f.fails + 1 else 1 end, until = excluded.until $$;

-- トークンの持ち主。①新しい窓口のログイン（アカウントの今の権限を毎回見る） ②今のダッシュボードのログイン
create or replace function public.settle_whoami(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with h as (select encode(sha256(convert_to(coalesce(p_token,''),'UTF8')),'hex') h where length(coalesce(p_token,'')) >= 32)
  select coalesce(
    (select jsonb_build_object('id', a.login_id, 'name', a.name, 'role', a.role, 'storesRaw', a.stores_raw, 'email', a.email)
     from h join public.settle_sessions s on s.token_hash = h.h and s.expires_at > now()
            join public.settle_accounts a on a.login_id = s.login_id and a.enabled),
    (select jsonb_build_object('id', x.sess->>'id', 'name', x.sess->>'name', 'role', x.sess->>'role', 'storesRaw', x.sess->>'storesRaw', 'email', x.sess->>'email')
     from h join public.sd_dash_grant g on g.token_hash = h.h and g.expires_at > now()
            join public.ds_sessions x on x.token = p_token and x.expires_at > now() and x.sess ? 'storesRaw' and x.sess->>'role' = g.user_role))
$$;

create or replace function public.settle_import(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c jsonb;
begin
  if coalesce(jsonb_array_length(p->'stores'),0) = 0 or coalesce(jsonb_array_length(p->'lines'),0) = 0 then
    raise exception 'stores か lines が空です（取り込みを中止しました）';
  end if;
  perform pg_advisory_xact_lock(hashtext('settle_import'));
  if (select value from public.settle_config where key = 'mode') = 'live' then
    raise exception '切り替え後のため、スプレッドシートからの取り込みはできません';
  end if;

  delete from public.settle_stores where true;
  delete from public.settle_store_periods where true;
  delete from public.settle_lines where true;
  delete from public.settle_recurring_items where true;
  delete from public.settle_payment_events where true;
  delete from public.settle_issue_logs where true;
  delete from public.settle_sales_monthly where true;
  delete from public.settle_sheet_rows where true;

  insert into public.settle_stores (store_key, name, sort_order, client, corp, invoice_number, representative, rate_text, rate_pct,
                                    rent, insurance, accounting_fee, fixed4, fixed5, required_items, db_sheet, sales_name, mail, issued)
  select public.settle_norm(x->>'name'), x->>'name', n::int, x->>'client', x->>'corp', x->>'invoice', x->>'rep', x->>'rate',
         coalesce((x->>'ratePct')::numeric,0),
         coalesce((x->>'rent')::numeric,0), coalesce((x->>'ins')::numeric,0), coalesce((x->>'sss')::numeric,0),
         coalesce((x->>'f4')::numeric,0), coalesce((x->>'f5')::numeric,0),
         coalesce(x->'required','[]'::jsonb), x->>'dbSheet', x->>'salesName', x->'mail', coalesce(x->'issued','{}'::jsonb)
  from jsonb_array_elements(p->'stores') with ordinality as a(x, n);

  -- 正本の店舗との対応（精算で使っている店舗名が一致するもの）
  update public.settle_stores st set store_id = s.id
  from public.stores s
  where public.settle_norm(s.seisan_store_name) = st.store_key or public.settle_norm(s.name) = st.store_key;

  insert into public.settle_store_periods (store_key, from_month, client, corp, invoice_number, representative)
  select public.settle_norm(x->>'store'), x->>'from', x->>'client', x->>'corp', x->>'invoice', x->>'rep'
  from jsonb_array_elements(coalesce(p->'periods','[]')) x;

  insert into public.settle_lines (store_key, month, kubun, item, amount, tax, note, editor, entered_at, edited_at, paid_mark,
                                   account, sub_account, ext_ref, legacy_sheet, legacy_row)
  select public.settle_norm(x->>'store'), x->>'ym', x->>'kubun', x->>'item', coalesce((x->>'amount')::numeric,0), x->>'tax', x->>'note',
         x->>'editor', x->>'at', x->>'edited', x->>'paid', x->>'account', x->>'subAccount', nullif(x->>'extRef',''),
         x->>'sheet', (x->>'row')::int
  from jsonb_array_elements(p->'lines') x;

  insert into public.settle_recurring_items (store_key, kubun, item, amount, tax, note, status)
  select public.settle_norm(x->>'store'), x->>'kubun', x->>'item', coalesce((x->>'amount')::numeric,0), x->>'tax', x->>'note', x->>'status'
  from jsonb_array_elements(coalesce(p->'recurring','[]')) x;

  insert into public.settle_payment_events (seq, target_key, target_name, month, done, paid_date, recorded_by, amount)
  select (x->>'seq')::int, public.settle_norm(x->>'name'), x->>'name', x->>'month', (x->>'done')::boolean, x->>'date', x->>'by',
         (x->>'amount')::numeric
  from jsonb_array_elements(coalesce(p->'payments','[]')) x;

  insert into public.settle_issue_logs (seq, logged_at, action, store, month, file_name, file_id, url, who, sent_to)
  select n::int, x->>'at', x->>'action', x->>'store', x->>'month', x->>'fileName', x->>'fileId', x->>'url', x->>'who', x->>'to'
  from jsonb_array_elements(coalesce(p->'logs','[]')) with ordinality as a(x, n);

  insert into public.settle_sales_monthly (sales_key, month, pay_total, point_total)
  select x->>'key', x->>'month', coalesce((x->>'pay')::numeric,0), (x->>'point')::numeric
  from jsonb_array_elements(coalesce(p->'sales','[]')) x;

  insert into public.settle_sheet_rows (sheet, row_no, cells)
  select s.key, r.n::int, r.v
  from jsonb_each(coalesce(p->'sheets','{}')) s, jsonb_array_elements(s.value) with ordinality as r(v, n);

  c := jsonb_build_object(
    'stores', (select count(*) from public.settle_stores),
    'storesMatched', (select count(*) from public.settle_stores where store_id is not null),
    'lines', (select count(*) from public.settle_lines),
    'payments', (select count(*) from public.settle_payment_events),
    'logs', (select count(*) from public.settle_issue_logs),
    'sales', (select count(*) from public.settle_sales_monthly));

  -- ログインのアカウントと利用申請（パスワードは、GAS側で読めない形にしたものだけが送られてくる）
  if p ? 'accounts' then
    if coalesce(jsonb_array_length(p->'accounts'),0) = 0 then raise exception 'accounts が空です（取り込みを中止しました）'; end if;
    if exists (select 1 from jsonb_array_elements(p->'accounts') x
               where coalesce(x->>'pwHash','') <> '' and x->>'pwHash' !~ '^(sha256|pbkdf2)\$') then
      raise exception 'パスワードが読める形のまま送られています（取り込みを中止しました）'; end if;
    delete from public.settle_accounts where true;
    insert into public.settle_accounts (login_id, pw_hash, name, role, stores_raw, enabled, email, sort_order)
    select distinct on (x->>'id') x->>'id', coalesce(x->>'pwHash',''), coalesce(x->>'name',''), x->>'role', coalesce(x->>'stores',''),
           coalesce((x->>'enabled')::boolean, false), lower(coalesce(x->>'email','')), n::int
    from jsonb_array_elements(p->'accounts') with ordinality as a(x, n) where coalesce(x->>'id','') <> ''
    order by x->>'id', n;
    -- 無効になった人や、いなくなった人のログインは切る
    delete from public.settle_sessions s where not exists (select 1 from public.settle_accounts a where a.login_id = s.login_id and a.enabled);
  end if;
  if p ? 'requests' then
    delete from public.settle_access_requests where true;
    insert into public.settle_access_requests (id, at_text, email, name, company, status, handled_by, created_id, note, base_id)
    select distinct on (x->>'id') x->>'id', x->>'at', lower(x->>'email'), x->>'name', x->>'company', x->>'status', x->>'by', x->>'createdId', x->>'note', x->>'baseId'
    from jsonb_array_elements(p->'requests') x where coalesce(x->>'id','') <> '';
  end if;

  insert into public.settle_import_runs (gas_ver, this_month, settings, counts, expected)
  values (p->>'ver', p->>'thisMonth', coalesce(p->'settings','{}'), c, coalesce(p->'expected','[]'));
  delete from public.settle_import_runs where id not in (select id from public.settle_import_runs order by id desc limit 50);
  return c;
end $$;

create or replace function public.settle_read(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with s as (select public.settle_whoami(p_token) u),
  r as (select imported_at from public.settle_import_runs order by id desc limit 1)
  select jsonb_build_object(
    'user', s.u,
    'importedAt', r.imported_at,
    'data', jsonb_build_object(
      'stores',   (select coalesce(jsonb_agg(to_jsonb(t) - 'mail'), '[]') from public.settle_stores t),
      'periods',  (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.settle_store_periods t),
      'lines',    (select coalesce(jsonb_agg(to_jsonb(t) order by t.store_key, t.legacy_row nulls last, t.id), '[]') from public.settle_lines t where t.deleted_at is null),
      'payments', (select coalesce(jsonb_agg(to_jsonb(t) order by t.seq), '[]') from public.settle_payment_events t),
      'logs',     (select coalesce(jsonb_agg(to_jsonb(t) order by t.seq), '[]') from public.settle_issue_logs t),
      'sales',    (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.settle_sales_monthly t),
      'corpRows', (select coalesce(jsonb_agg(t.cells order by t.row_no), '[]') from public.settle_sheet_rows t where t.sheet like '法人設定%')))
  from s, r where s.u is not null
$$;


revoke all on function public.settle_add_fail(text, int), public.settle_whoami(text), public.settle_import(jsonb), public.settle_read(text) from public, anon, authenticated;
grant execute on function public.settle_add_fail(text, int), public.settle_whoami(text), public.settle_import(jsonb), public.settle_read(text) to service_role;
commit;

-- 精算ダッシュボードの移行 段階1（2026-11-26）: データの写し先と、金額の突き合わせ
-- この段階の正本はスプレッドシートのまま。ここの表は GAS からの取り込みで毎回まるごと入れ替わる。
-- 画面や外の仕組みからは読めない（service_role だけ）。ログイン情報・パスワードは取り込まない。
--
-- 元に戻す:
--   drop function if exists public.settle_import(jsonb), public.settle_calc(), public.settle_compare(), public.settle_norm(text);
--   drop table if exists public.settle_import_runs, public.settle_stores, public.settle_store_periods, public.settle_lines,
--     public.settle_recurring_items, public.settle_payment_events, public.settle_issue_logs, public.settle_sales_monthly,
--     public.settle_sheet_rows;

begin;

-- 店舗名などの表記ゆれをそろえる（GASの sd_norm_ と同じ: 空白を除き、％を%に）
create or replace function public.settle_norm(t text) returns text
language sql immutable set search_path = '' as $$
  select replace(regexp_replace(coalesce(t,''), '[[:space:]　 ]+', '', 'g'), '％', '%')
$$;

create table if not exists public.settle_import_runs (
  id          bigint generated always as identity primary key,
  imported_at timestamptz not null default now(),
  gas_ver     text,
  this_month  text not null,              -- 取り込んだ時点の今月（レジ実績を使う範囲の判定に使う）
  settings    jsonb not null default '{}'::jsonb,
  counts      jsonb not null default '{}'::jsonb,
  expected    jsonb not null default '[]'::jsonb  -- GASが計算した店舗×月の結果（突き合わせの正解）
);

create table if not exists public.settle_stores (
  store_key  text primary key,            -- settle_norm(店舗名)
  name       text not null,
  store_id   uuid,                        -- 正本 public.stores（対応が取れたもの）
  sort_order int not null,
  client text, corp text, invoice_number text, representative text,
  rate_text  text, rate_pct numeric not null default 0,
  rent numeric not null default 0, insurance numeric not null default 0, accounting_fee numeric not null default 0,
  fixed4 numeric not null default 0, fixed5 numeric not null default 0,
  required_items jsonb not null default '[]'::jsonb,
  db_sheet text, sales_name text,
  mail jsonb
);

create table if not exists public.settle_store_periods (  -- 委託先の期間設定
  id bigint generated always as identity primary key,
  store_key text not null, from_month text not null,
  client text not null, corp text, invoice_number text, representative text
);

create table if not exists public.settle_lines (
  id bigint generated always as identity primary key,
  store_key text not null, month text not null,
  kubun text, item text, amount numeric not null default 0, tax text, note text,
  editor text, entered_at text, edited_at text, paid_mark text,
  account text, sub_account text, ext_ref text,
  legacy_sheet text not null, legacy_row int not null,
  unique (legacy_sheet, legacy_row)
);
create index if not exists settle_lines_store_month on public.settle_lines (store_key, month);

create table if not exists public.settle_recurring_items (
  id bigint generated always as identity primary key,
  store_key text not null, kubun text, item text, amount numeric not null default 0, tax text, note text, status text
);

create table if not exists public.settle_payment_events (  -- 振込管理（操作の履歴。後の行が現在の状態）
  seq int primary key,
  target_key text not null, target_name text, month text not null,
  done boolean not null, paid_date text, recorded_by text, amount numeric
);

create table if not exists public.settle_issue_logs (
  seq int primary key,
  logged_at text, action text, store text, month text, file_name text, file_id text, url text, who text, sent_to text
);

create table if not exists public.settle_sales_monthly (
  sales_key text not null, month text not null,
  pay_total numeric not null default 0, point_total numeric,
  primary key (sales_key, month)
);

create table if not exists public.settle_sheet_rows (     -- 法人設定・PL対応表など、後で形を決めるシートは行のまま持つ
  sheet text not null, row_no int not null, cells jsonb not null,
  primary key (sheet, row_no)
);

do $$
declare t text;
begin
  foreach t in array array['settle_import_runs','settle_stores','settle_store_periods','settle_lines','settle_recurring_items',
                           'settle_payment_events','settle_issue_logs','settle_sales_monthly','settle_sheet_rows'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- GASからの取り込み（1回の呼び出し＝1つのまとまり。途中で失敗したら全部なかったことになる）
create or replace function public.settle_import(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c jsonb;
begin
  if coalesce(jsonb_array_length(p->'stores'),0) = 0 or coalesce(jsonb_array_length(p->'lines'),0) = 0 then
    raise exception 'stores か lines が空です（取り込みを中止しました）';
  end if;
  perform pg_advisory_xact_lock(hashtext('settle_import'));

  delete from public.settle_stores where true;
  delete from public.settle_store_periods where true;
  delete from public.settle_lines where true;
  delete from public.settle_recurring_items where true;
  delete from public.settle_payment_events where true;
  delete from public.settle_issue_logs where true;
  delete from public.settle_sales_monthly where true;
  delete from public.settle_sheet_rows where true;

  insert into public.settle_stores (store_key, name, sort_order, client, corp, invoice_number, representative, rate_text, rate_pct,
                                    rent, insurance, accounting_fee, fixed4, fixed5, required_items, db_sheet, sales_name, mail)
  select public.settle_norm(x->>'name'), x->>'name', n::int, x->>'client', x->>'corp', x->>'invoice', x->>'rep', x->>'rate',
         coalesce((x->>'ratePct')::numeric,0),
         coalesce((x->>'rent')::numeric,0), coalesce((x->>'ins')::numeric,0), coalesce((x->>'sss')::numeric,0),
         coalesce((x->>'f4')::numeric,0), coalesce((x->>'f5')::numeric,0),
         coalesce(x->'required','[]'::jsonb), x->>'dbSheet', x->>'salesName', x->'mail'
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

  insert into public.settle_import_runs (gas_ver, this_month, settings, counts, expected)
  values (p->>'ver', p->>'thisMonth', coalesce(p->'settings','{}'), c, coalesce(p->'expected','[]'));
  delete from public.settle_import_runs where id not in (select id from public.settle_import_runs order by id desc limit 50);
  return c;
end $$;

-- 店舗×月の精算計算（GASの sd_settle_ と同じ。四捨五入は JavaScript の Math.round に合わせて floor(x+0.5)）
create or replace function public.settle_calc()
returns table (store_key text, month text, cnt int, sales numeric, var_cost numeric, roy_fixed numeric, roy_var numeric,
               roy_base numeric, adj numeric, fixed_sub numeric, cost_total numeric, transfer numeric, transfer_ex numeric,
               client text, paid boolean, paid_total numeric)
language sql stable security definer set search_path = '' as $$
  with run as (select this_month from public.settle_import_runs order by id desc limit 1),
  months as (
    select distinct x->>'month' m from public.settle_import_runs r, jsonb_array_elements(r.expected) x
    where r.id = (select max(id) from public.settle_import_runs)
    union select distinct l.month from public.settle_lines l),
  agg as (
    select s.store_key, m.m,
      count(l.id)::int cnt,
      coalesce(sum(l.amount) filter (where public.settle_norm(l.kubun) = '売上'),0) sales,
      coalesce(sum(l.amount) filter (where public.settle_norm(l.kubun) = '固定ロイヤリティ'),0) royf,
      coalesce(sum(l.amount) filter (where public.settle_norm(l.kubun) = '固定調整'),0) adj,
      coalesce(sum(l.amount) filter (where public.settle_norm(l.kubun) not in ('売上','固定ロイヤリティ','変動ロイヤリティ','固定調整')),0) varcost
    from public.settle_stores s cross join months m
    left join public.settle_lines l on l.store_key = s.store_key and l.month = m.m
    group by s.store_key, m.m),
  b as (
    select a.*, s.rate_pct, (s.rent + s.insurance + s.accounting_fee + s.fixed4 + s.fixed5) fixed,
      case when a.m >= '2026-09' and a.m <= (select this_month from run) and coalesce(sm.pay_total,0) > 0
           then sm.pay_total else a.sales end roybase,
      coalesce((select p.client from public.settle_store_periods p where p.store_key = a.store_key and p.from_month <= a.m
                order by p.from_month desc, p.id limit 1), s.client, '') client
    from agg a
    join public.settle_stores s on s.store_key = a.store_key
    left join public.settle_sales_monthly sm on sm.sales_key = public.settle_norm(s.sales_name) and sm.month = a.m),
  c as (select b.*, floor(b.roybase::float8 * (b.rate_pct::float8 / 100) + 0.5)::numeric royv from b),
  d as (select c.*, (c.fixed + c.adj) + c.varcost + c.royf + c.royv costtotal from c),
  pay as (  -- 法人×月、店舗×月の現在の状態
    select e.target_key, e.month,
      (array_agg(e.done order by e.seq desc))[1] done,
      coalesce(sum(e.amount) filter (where e.done),0) total
    from public.settle_payment_events e group by e.target_key, e.month)
  select d.store_key, d.m, d.cnt, d.sales, d.varcost, d.royf, d.royv, d.roybase, d.adj, d.fixed + d.adj, d.costtotal,
         d.sales - d.costtotal, floor((d.sales - d.costtotal)::float8 / 1.1::float8 + 0.5)::numeric, d.client,
         coalesce(case when pc.target_key is not null then pc.done else ps.done end, false),
         coalesce(case when pc.target_key is not null then pc.total else ps.total end, 0)
  from d
  left join pay pc on pc.target_key = public.settle_norm(case when d.client = '' then '（委託先未設定）' else d.client end) and pc.month = d.m
  left join pay ps on ps.target_key = d.store_key and ps.month = d.m
$$;

-- 直近の取り込みについて、GASの計算結果との違いを返す（0行なら完全一致）
create or replace function public.settle_compare()
returns table (store_key text, month text, field text, gas text, db text)
language sql stable security definer set search_path = '' as $$
  with e as (
    select public.settle_norm(x->>'store') as store_key, x->>'month' as month, x
    from public.settle_import_runs r, jsonb_array_elements(r.expected) x
    where r.id = (select max(id) from public.settle_import_runs)),
  j as (
    select e.store_key, e.month, e.x gas, to_jsonb(c) db
    from e left join public.settle_calc() c on c.store_key = e.store_key and c.month = e.month),
  f(gas_field, db_field) as (values ('count','cnt'),('sales','sales'),('varCost','var_cost'),('royF','roy_fixed'),('royV','roy_var'),
    ('royBase','roy_base'),('costTotal','cost_total'),('transfer','transfer'),('transferEx','transfer_ex'),
    ('client','client'),('paid','paid'),('paidTotal','paid_total'))
  select j.store_key, j.month, f.gas_field, j.gas->>f.gas_field, j.db->>f.db_field
  from j cross join f
  where case when f.gas_field in ('client') then public.settle_norm(j.gas->>f.gas_field) is distinct from public.settle_norm(j.db->>f.db_field)
             when f.gas_field = 'paid' then (j.gas->>f.gas_field) is distinct from (j.db->>f.db_field)
             else (j.gas->>f.gas_field)::numeric is distinct from (j.db->>f.db_field)::numeric end
$$;

revoke all on function public.settle_norm(text)     from public, anon, authenticated;
revoke all on function public.settle_import(jsonb)  from public, anon, authenticated;
revoke all on function public.settle_calc()         from public, anon, authenticated;
revoke all on function public.settle_compare()      from public, anon, authenticated;
grant execute on function public.settle_norm(text), public.settle_import(jsonb), public.settle_calc(), public.settle_compare() to service_role;

commit;

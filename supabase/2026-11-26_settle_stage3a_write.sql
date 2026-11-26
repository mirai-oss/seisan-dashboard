-- 移行 段階3-1（2026-11-26）: 書き込みの中心部分。切り替え（settle_config の mode='live'）までは、どれも書き込みを断る。
-- 今の画面・スプレッドシート・毎朝の取り込みには影響しない。
-- 元に戻す: 下で追加した関数と settle_config / settle_audit を drop し、settle_lines の追加列を drop。
begin;
create table if not exists public.settle_config (key text primary key, value text not null);
insert into public.settle_config (key, value) values ('mode','copy'), ('lock_level','master') on conflict (key) do nothing;
create table if not exists public.settle_audit (
  id bigint generated always as identity primary key, at timestamptz not null default now(),
  actor text, action text not null, store_key text, month text, before jsonb, after jsonb);
alter table public.settle_config enable row level security;
alter table public.settle_audit enable row level security;
revoke all on public.settle_config, public.settle_audit from public, anon, authenticated;
alter table public.settle_lines add column if not exists deleted_at timestamptz;
alter table public.settle_lines add column if not exists deleted_by text;
alter table public.settle_lines add column if not exists updated_at timestamptz;
alter table public.settle_lines alter column legacy_sheet drop not null;
alter table public.settle_lines alter column legacy_row drop not null;

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

  insert into public.settle_import_runs (gas_ver, this_month, settings, counts, expected)
  values (p->>'ver', p->>'thisMonth', coalesce(p->'settings','{}'), c, coalesce(p->'expected','[]'));
  delete from public.settle_import_runs where id not in (select id from public.settle_import_runs order by id desc limit 50);
  return c;
end $$;

create or replace function public.settle_calc()
returns table (store_key text, month text, cnt int, sales numeric, var_cost numeric, roy_fixed numeric, roy_var numeric,
               roy_base numeric, adj numeric, fixed_sub numeric, cost_total numeric, transfer numeric, transfer_ex numeric,
               client text, paid boolean, paid_total numeric)
language sql stable security definer set search_path = '' as $$
  with run as (select this_month from public.settle_import_runs order by id desc limit 1),
  months as (
    select distinct x->>'month' m from public.settle_import_runs r, jsonb_array_elements(r.expected) x
    where r.id = (select max(id) from public.settle_import_runs)
    union select distinct l.month from public.settle_lines l where l.deleted_at is null),
  agg as (
    select s.store_key, m.m,
      count(l.id)::int cnt,
      coalesce(sum(l.amount) filter (where public.settle_norm(l.kubun) = '売上'),0) sales,
      coalesce(sum(l.amount) filter (where public.settle_norm(l.kubun) = '固定ロイヤリティ'),0) royf,
      coalesce(sum(l.amount) filter (where public.settle_norm(l.kubun) = '固定調整'),0) adj,
      coalesce(sum(l.amount) filter (where public.settle_norm(l.kubun) not in ('売上','固定ロイヤリティ','変動ロイヤリティ','固定調整')),0) varcost
    from public.settle_stores s cross join months m
    left join public.settle_lines l on l.store_key = s.store_key and l.month = m.m and l.deleted_at is null
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
      'lines',    (select coalesce(jsonb_agg(to_jsonb(t) order by t.store_key, t.legacy_row nulls last, t.id), '[]') from public.settle_lines t where t.deleted_at is null),
      'payments', (select coalesce(jsonb_agg(to_jsonb(t) order by t.seq), '[]') from public.settle_payment_events t),
      'logs',     (select coalesce(jsonb_agg(to_jsonb(t) order by t.seq), '[]') from public.settle_issue_logs t),
      'sales',    (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.settle_sales_monthly t),
      'corpRows', (select coalesce(jsonb_agg(t.cells order by t.row_no), '[]') from public.settle_sheet_rows t where t.sheet like '法人設定%')))
  from s, r
$$;

-- ---------- 書き込みの中心部分（本番の正本にする時に使う。切り替え前は何も書けない） ----------
create or replace function public.settle_today() returns text language sql stable set search_path = '' as $$
  select to_char(now() at time zone 'Asia/Tokyo', 'FMMM/FMDD') $$;

create or replace function public.settle_require_live() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce((select value from public.settle_config where key = 'mode'), 'copy') <> 'live' then
    raise exception '切り替え前のため、ここでは書き込めません';
  end if;
end $$;

create or replace function public.settle_amount(t text) returns numeric
language plpgsql immutable set search_path = '' as $$
declare v text := regexp_replace(coalesce(t,''), '[¥￥,，[:space:]　]', '', 'g');
begin
  if v !~ '^-?[0-9]+(\.[0-9]+)?$' then return null; end if;
  return v::numeric;
end $$;

create or replace function public.settle_require_hq(actor jsonb) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if coalesce(actor->>'role','') not in ('本部','マスター') then raise exception 'この操作は本部アカウントのみ実行できます'; end if;
end $$;

create or replace function public.settle_key_of(p_store text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare k text;
begin
  select store_key into k from public.settle_stores where name = p_store;
  if k is null then raise exception '店舗が見つかりません: %', p_store; end if;
  return k;
end $$;

create or replace function public.settle_client_at(p_key text, p_month text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p.client from public.settle_store_periods p where p.store_key = p_key and p.from_month <= p_month order by p.from_month desc, p.id limit 1),
    (select s.client from public.settle_stores s where s.store_key = p_key), '') $$;

-- 振込済みか（法人の記録を優先し、無い月だけ旧式の店舗ごとの記録）
create or replace function public.settle_is_locked(p_key text, p_month text) returns boolean
language sql stable security definer set search_path = '' as $$
  with c as (select public.settle_norm(coalesce(nullif(public.settle_client_at(p_key, p_month), ''), '（委託先未設定）')) k)
  select coalesce(
    (select e.done from public.settle_payment_events e, c where e.target_key = c.k and e.month = p_month order by e.seq desc limit 1),
    (select e.done from public.settle_payment_events e where e.target_key = p_key and e.month = p_month order by e.seq desc limit 1),
    false) $$;

create or replace function public.settle_require_unlocked(actor jsonb, p_key text, p_month text) returns void
language plpgsql stable security definer set search_path = '' as $$
declare lv text := coalesce((select value from public.settle_config where key = 'lock_level'), 'master');
begin
  if actor->>'role' = 'マスター' or (lv = 'admin' and actor->>'role' = '本部') then return; end if;
  if public.settle_is_locked(p_key, p_month) then
    raise exception '🔒 % 分は振込済みでロックされています。編集には%アカウントが必要です。', p_month, case when lv = 'admin' then '本部以上の' else 'マスター' end;
  end if;
end $$;

create or replace function public.settle_log(actor jsonb, p_action text, p_key text, p_month text, p_before jsonb, p_after jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.settle_audit (actor, action, store_key, month, before, after)
  values (coalesce(actor->>'name',''), p_action, p_key, p_month, p_before, p_after) $$;

create or replace function public.settle_insert_line(p_key text, p_month text, r jsonb, p_editor text) returns bigint
language sql security definer set search_path = '' as $$
  insert into public.settle_lines (store_key, month, kubun, item, amount, tax, note, editor, entered_at, account, sub_account, ext_ref)
  values (p_key, p_month, coalesce(nullif(r->>'kubun',''),'変動費'), btrim(r->>'item'), public.settle_amount(r->>'amount'),
          coalesce(nullif(r->>'tax',''),'10%'), coalesce(r->>'note',''), p_editor, public.settle_today(),
          coalesce(r->>'account',''), coalesce(r->>'subAccount',''), nullif(r->>'extRef',''))
  returning id $$;

create or replace function public.settle_add_rows(actor jsonb, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text; m text := p->>'month'; r jsonb; n int := 0; dups text[] := '{}'; new_id bigint;
begin
  perform public.settle_require_live(); perform public.settle_require_hq(actor);
  k := public.settle_key_of(p->>'store');
  if coalesce(m,'') !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception '対象月の形式が不正です'; end if;
  perform pg_advisory_xact_lock(hashtext('settle:' || k));
  perform public.settle_require_unlocked(actor, k, m);
  if not exists (select 1 from jsonb_array_elements(coalesce(p->'rows','[]')) x where btrim(coalesce(x->>'item','')) <> '') then
    raise exception '明細が入力されていません'; end if;
  for r in select x from jsonb_array_elements(p->'rows') x where btrim(coalesce(x->>'item','')) <> '' loop
    if public.settle_amount(r->>'amount') is null then raise exception '金額が数値ではありません: %', r->>'item'; end if;
    if exists (select 1 from public.settle_lines l where l.store_key = k and l.month = m and l.deleted_at is null
               and public.settle_norm(l.item) = public.settle_norm(r->>'item') and l.amount = public.settle_amount(r->>'amount')) then
      dups := dups || format('%s（¥%s）', r->>'item', to_char(public.settle_amount(r->>'amount'), 'FM999,999,999,990'));
    end if;
  end loop;
  if coalesce((p->>'force')::boolean, false) = false and array_length(dups,1) > 0 then
    return jsonb_build_object('ok', false, 'dup', to_jsonb(dups));
  end if;
  for r in select x from jsonb_array_elements(p->'rows') x where btrim(coalesce(x->>'item','')) <> '' loop
    new_id := public.settle_insert_line(k, m, r - 'extRef', coalesce(nullif(p->>'editor',''), actor->>'name'));
    perform public.settle_log(actor, '明細登録', k, m, null, r || jsonb_build_object('id', new_id));
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'added', n, 'month', m);
end $$;

-- 修正・削除: 画面が持っている費目と金額が今の内容と違えば、書き換えない（同時に直した人の分を壊さない）
create or replace function public.settle_target_line(actor jsonb, p jsonb) returns public.settle_lines
language plpgsql security definer set search_path = '' as $$
declare k text; l public.settle_lines;
begin
  perform public.settle_require_live(); perform public.settle_require_hq(actor);
  k := public.settle_key_of(p->>'store');
  perform pg_advisory_xact_lock(hashtext('settle:' || k));
  select * into l from public.settle_lines where id = (p->>'row')::bigint and store_key = k and deleted_at is null for update;
  if l.id is null or public.settle_norm(l.item) <> public.settle_norm(p->'orig'->>'item')
     or round(l.amount) <> round(public.settle_amount(p->'orig'->>'amount')) then
    raise exception 'この行は別の場所で変更されています。再読込してからもう一度操作してください';
  end if;
  perform public.settle_require_unlocked(actor, k, l.month);
  return l;
end $$;

create or replace function public.settle_update_row(actor jsonb, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.settle_lines; item_new text := btrim(coalesce(p->>'item','')); amt numeric := public.settle_amount(p->>'amount'); a public.settle_lines;
begin
  l := public.settle_target_line(actor, p);
  if item_new = '' then raise exception '費目名が空です'; end if;
  if amt is null then raise exception '金額が数値ではありません'; end if;
  update public.settle_lines set kubun = coalesce(nullif(p->>'kubun',''),'変動費'), item = item_new, amount = amt,
    tax = coalesce(nullif(p->>'tax',''),'10%'), note = coalesce(p->>'note',''), account = coalesce(p->>'account',''),
    sub_account = coalesce(p->>'subAccount',''), edited_at = public.settle_today() || ' ' || (actor->>'name'), updated_at = now()
  where id = l.id returning * into a;
  perform public.settle_log(actor, '明細修正', l.store_key, l.month, to_jsonb(l), to_jsonb(a));
  return jsonb_build_object('ok', true, 'row', l.id, 'item', item_new);
end $$;

create or replace function public.settle_delete_row(actor jsonb, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.settle_lines;
begin
  l := public.settle_target_line(actor, p);
  update public.settle_lines set deleted_at = now(), deleted_by = actor->>'name' where id = l.id;
  perform public.settle_log(actor, '明細削除', l.store_key, l.month, to_jsonb(l), null);
  return jsonb_build_object('ok', true, 'item', l.item, 'amount', l.amount);
end $$;

create or replace function public.settle_bulk_add(actor jsonb, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text; m text := p->>'fromMonth'; to_m text := p->>'toMonth'; amt numeric := public.settle_amount(p->>'amount');
  done text[] := '{}'; skipped text[] := '{}'; n int := 0;
begin
  perform public.settle_require_live(); perform public.settle_require_hq(actor);
  k := public.settle_key_of(p->>'store');
  if btrim(coalesce(p->>'item','')) = '' then raise exception '費目名を入力してください'; end if;
  if amt is null then raise exception '金額が数値ではありません'; end if;
  if coalesce(m,'') !~ '^\d{4}-(0[1-9]|1[0-2])$' or coalesce(to_m,'') !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception '対象月の形式が不正です'; end if;
  if m > to_m then raise exception '開始月が終了月より後になっています'; end if;
  perform pg_advisory_xact_lock(hashtext('settle:' || k));
  while m <= to_m and n < 60 loop
    if actor->>'role' <> 'マスター' and public.settle_is_locked(k, m) then skipped := skipped || m;
    else
      perform public.settle_insert_line(k, m, jsonb_build_object('kubun', p->>'kubun', 'item', p->>'item', 'amount', amt, 'tax', p->>'tax',
        'note', coalesce(nullif(p->>'note',''),'一括計上'), 'account', p->>'account', 'subAccount', p->>'subAccount'), actor->>'name');
      done := done || m;
    end if;
    m := to_char((m || '-01')::date + interval '1 month', 'YYYY-MM'); n := n + 1;
  end loop;
  if array_length(done,1) is null then raise exception '🔒 指定された月はすべて振込済みでロックされています（マスターアカウントが必要です）'; end if;
  perform public.settle_log(actor, '一括計上', k, done[1], null, p || jsonb_build_object('months', to_jsonb(done)));
  return jsonb_build_object('ok', true, 'months', to_jsonb(done), 'item', p->>'item', 'amount', amt, 'store', p->>'store', 'lockedSkipped', to_jsonb(skipped));
end $$;

-- 振込済み／解除（法人×月の記録を1行足す。解除はマスターのみ）。メールと PL の起動は呼び出し側で行う
create or replace function public.settle_set_paid(actor jsonb, p_client text, p_month text, p_done boolean, p_amount numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare members text[]; k text := public.settle_norm(p_client);
begin
  perform public.settle_require_live(); perform public.settle_require_hq(actor);
  perform pg_advisory_xact_lock(hashtext('settle:paid'));
  select array_agg(s.name order by s.sort_order) into members from public.settle_stores s
   where public.settle_norm(coalesce(nullif(public.settle_client_at(s.store_key, p_month),''),'（委託先未設定）')) = k;
  if members is null then raise exception '「%」に該当する店舗が見つかりません', p_client; end if;
  if not p_done and actor->>'role' <> 'マスター'
     and exists (select 1 from public.settle_stores s where s.name = any(members) and public.settle_is_locked(s.store_key, p_month)) then
    raise exception 'この操作はマスターアカウントのみ実行できます'; end if;
  if p_done and p_amount is null then raise exception '振込金額を入力してください'; end if;
  insert into public.settle_payment_events (seq, target_key, target_name, month, done, paid_date, recorded_by, amount)
  values (coalesce((select max(seq) from public.settle_payment_events), 1) + 1, k, p_client, p_month, p_done,
          case when p_done then to_char(now() at time zone 'Asia/Tokyo','YYYY-MM-DD') else '' end, actor->>'name', case when p_done then p_amount else 0 end);
  perform public.settle_log(actor, case when p_done then '振込済み' else '振込解除' end, null, p_month, null, jsonb_build_object('client', p_client, 'amount', p_amount));
  return jsonb_build_object('ok', true, 'client', p_client, 'month', p_month, 'done', p_done, 'amount', case when p_done then p_amount end, 'members', to_jsonb(members));
end $$;

-- 外の仕組み（請求書・経営ダッシュボード）からの明細。同じ連携元の行は上書きし、別の月に残る行は残さない
create or replace function public.settle_ext_remove(p_store text, p_month text, p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text; n int;
begin
  perform public.settle_require_live();
  k := public.settle_key_of(p_store);
  perform pg_advisory_xact_lock(hashtext('settle:' || k));
  if public.settle_is_locked(k, p_month) then
    return jsonb_build_object('removed', false, 'locked', true, 'reason', p_month || '分は振込済みのため削除されませんでした。手動確認が必要です'); end if;
  update public.settle_lines set deleted_at = now(), deleted_by = '自動連携' where store_key = k and month = p_month and ext_ref = p_key and deleted_at is null;
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('removed', false, 'reason', '該当行が見つかりませんでした（既に削除済みの可能性）'); end if;
  perform public.settle_log(jsonb_build_object('name','自動連携'), '外部明細の削除', k, p_month, jsonb_build_object('extRef', p_key, 'rows', n), null);
  return jsonb_build_object('removed', true, 'rows', n);
end $$;

create or replace function public.settle_ext_upsert(p_store text, p_month text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text; src text := left(btrim(coalesce(p->>'sourceKey','')), 200); amt numeric := public.settle_amount(p->>'amount');
  locked_old text; old_month text; l public.settle_lines; prev text := btrim(coalesce(p->>'previousStore','')); updated boolean := false;
begin
  perform public.settle_require_live();
  if coalesce(p_month,'') !~ '^\d{4}-(0[1-9]|1[0-2])$' then return jsonb_build_object('ok', false, 'error', '年月が不正です'); end if;
  if btrim(coalesce(p->>'item','')) = '' then return jsonb_build_object('ok', false, 'error', '費目名（item）が空です'); end if;
  if amt is null or amt < 0 then return jsonb_build_object('ok', false, 'error', '金額が不正です'); end if;
  if src = '' then return jsonb_build_object('ok', false, 'error', 'sourceKey（冪等キー）が空です'); end if;
  k := public.settle_key_of(p_store);
  perform pg_advisory_xact_lock(hashtext('settle:' || k));
  if public.settle_is_locked(k, p_month) then
    return jsonb_build_object('ok', false, 'locked', true, 'error', p_month || '分は振込済み（確定済み）のため自動追加できません'); end if;
  select string_agg(distinct x.month, '・') into locked_old from public.settle_lines x
   where x.store_key = k and x.ext_ref = src and x.deleted_at is null and x.month <> p_month and public.settle_is_locked(k, x.month);
  if locked_old is not null then
    return jsonb_build_object('ok', false, 'locked', true, 'error', 'この明細は ' || locked_old || '分（振込済み）に登録されています。二重計上を防ぐため、' || p_month || '分には追加しません'); end if;
  select * into l from public.settle_lines where store_key = k and month = p_month and ext_ref = src and deleted_at is null order by id limit 1;
  if l.id is not null then
    update public.settle_lines set kubun = coalesce(nullif(p->>'kubun',''),'変動費'), item = btrim(p->>'item'), amount = amt,
      tax = coalesce(nullif(p->>'tax',''),'10%'), account = coalesce(p->>'account',''), sub_account = coalesce(p->>'subAccount',''),
      note = coalesce(p->>'note',''), updated_at = now() where id = l.id;
    updated := true;
  else
    perform public.settle_insert_line(k, p_month, p || jsonb_build_object('extRef', src), '自動連携（A-8/A-10）');
  end if;
  for old_month in select distinct month from public.settle_lines where store_key = k and ext_ref = src and deleted_at is null and month <> p_month loop
    perform public.settle_ext_remove(p_store, old_month, src);
  end loop;
  if prev <> '' and prev <> p_store then perform public.settle_ext_remove(prev, p_month, src); end if;
  perform public.settle_log(jsonb_build_object('name','自動連携'), '外部明細の登録', k, p_month, to_jsonb(l), p);
  return jsonb_build_object('ok', true, 'updated', updated);
end $$;

revoke all on function public.settle_import(jsonb) from public, anon, authenticated;
grant execute on function public.settle_import(jsonb) to service_role;
revoke all on function public.settle_calc() from public, anon, authenticated;
grant execute on function public.settle_calc() to service_role;
revoke all on function public.settle_read(text) from public, anon, authenticated;
grant execute on function public.settle_read(text) to service_role;
revoke all on function public.settle_today() from public, anon, authenticated;
grant execute on function public.settle_today() to service_role;
revoke all on function public.settle_require_live() from public, anon, authenticated;
grant execute on function public.settle_require_live() to service_role;
revoke all on function public.settle_amount(text) from public, anon, authenticated;
grant execute on function public.settle_amount(text) to service_role;
revoke all on function public.settle_require_hq(jsonb) from public, anon, authenticated;
grant execute on function public.settle_require_hq(jsonb) to service_role;
revoke all on function public.settle_key_of(text) from public, anon, authenticated;
grant execute on function public.settle_key_of(text) to service_role;
revoke all on function public.settle_client_at(text, text) from public, anon, authenticated;
grant execute on function public.settle_client_at(text, text) to service_role;
revoke all on function public.settle_is_locked(text, text) from public, anon, authenticated;
grant execute on function public.settle_is_locked(text, text) to service_role;
revoke all on function public.settle_require_unlocked(jsonb, text, text) from public, anon, authenticated;
grant execute on function public.settle_require_unlocked(jsonb, text, text) to service_role;
revoke all on function public.settle_log(jsonb, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.settle_log(jsonb, text, text, text, jsonb, jsonb) to service_role;
revoke all on function public.settle_insert_line(text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.settle_insert_line(text, text, jsonb, text) to service_role;
revoke all on function public.settle_add_rows(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.settle_add_rows(jsonb, jsonb) to service_role;
revoke all on function public.settle_target_line(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.settle_target_line(jsonb, jsonb) to service_role;
revoke all on function public.settle_update_row(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.settle_update_row(jsonb, jsonb) to service_role;
revoke all on function public.settle_delete_row(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.settle_delete_row(jsonb, jsonb) to service_role;
revoke all on function public.settle_bulk_add(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.settle_bulk_add(jsonb, jsonb) to service_role;
revoke all on function public.settle_set_paid(jsonb, text, text, boolean, numeric) from public, anon, authenticated;
grant execute on function public.settle_set_paid(jsonb, text, text, boolean, numeric) to service_role;
revoke all on function public.settle_ext_remove(text, text, text) from public, anon, authenticated;
grant execute on function public.settle_ext_remove(text, text, text) to service_role;
revoke all on function public.settle_ext_upsert(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.settle_ext_upsert(text, text, jsonb) to service_role;
commit;

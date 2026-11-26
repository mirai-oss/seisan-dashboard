-- 移行 段階3-5b（2026-11-26）: 定期処理（定期費目・現金売上）、レジ売上の毎日の取り込み、切り替えの切替口。
-- 画面からの定期処理は mode='live' まで断る。レジ売上の取り込みは切り替え後も使う。
begin;
alter table public.settle_sales_monthly add column if not exists cash_total numeric;
alter table public.settle_sales_monthly add column if not exists cash_days int;

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

  insert into public.settle_sales_monthly (sales_key, month, pay_total, point_total, cash_total, cash_days)
  select x->>'key', x->>'month', coalesce((x->>'pay')::numeric,0), (x->>'point')::numeric, (x->>'cash')::numeric, (x->>'cashDays')::int
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


-- レジの月間売上の取り込み（毎日。切り替え後はここだけが売上の入口）
create or replace function public.settle_sales_push(p jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if coalesce(jsonb_array_length(p),0) = 0 then raise exception '売上が空です（取り込みを中止しました）'; end if;
  insert into public.settle_sales_monthly as s (sales_key, month, pay_total, point_total, cash_total, cash_days)
  select x->>'key', x->>'month', coalesce((x->>'pay')::numeric,0), (x->>'point')::numeric, (x->>'cash')::numeric, (x->>'cashDays')::int
  from jsonb_array_elements(p) x where x->>'month' ~ '^\d{4}-\d{2}$' and coalesce(x->>'key','') <> ''
  on conflict (sales_key, month) do update set pay_total = excluded.pay_total, point_total = excluded.point_total,
    cash_total = excluded.cash_total, cash_days = excluded.cash_days;
  get diagnostics n = row_count; return n;
end $$;

-- 定期費目のセット: 前月の固定ロイヤリティの引き継ぎ ＋ 定期費目（有効・期間内）。同じ区分と費目があれば足さない
create or replace function public.settle_prepare_month(actor jsonb, p_month text, p_skip_locked boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s record; r record; added text[]; results text[] := '{}'; prev text;
begin
  perform public.settle_require_live(); perform public.settle_require_hq(actor);
  if coalesce(p_month,'') !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception '対象月の形式が不正です'; end if;
  prev := to_char((p_month || '-01')::date - interval '1 month', 'YYYY-MM');
  for s in select * from public.settle_stores order by sort_order loop
    perform pg_advisory_xact_lock(hashtext('settle:' || s.store_key));
    if p_skip_locked and public.settle_is_locked(s.store_key, p_month) then results := results || (s.name || ': 🔒振込済みのためスキップ'); continue; end if;
    added := '{}';
    for r in
      select kubun, item, amount, tax, note from (
        select 0 o, l.id ord, l.kubun, l.item, l.amount, coalesce(nullif(l.tax,''),'10%') tax, l.note from public.settle_lines l
         where l.store_key = s.store_key and l.month = prev and l.deleted_at is null and public.settle_norm(l.kubun) = '固定ロイヤリティ'
        union all
        select 1, c.id, c.kubun, c.item, c.amount, coalesce(nullif(c.tax,''),'10%'), coalesce(nullif(c.note,''),'定期費目（自動）') from public.settle_recurring_items c
         where c.store_key = s.store_key and c.deleted_at is null and coalesce(c.status,'') <> '停止'
           and (c.start_month is null or c.start_month <= p_month) and (c.end_month is null or c.end_month >= p_month)) q
      order by o, ord
    loop
      if exists (select 1 from public.settle_lines x where x.store_key = s.store_key and x.month = p_month and x.deleted_at is null
                 and public.settle_norm(x.kubun) = public.settle_norm(r.kubun) and public.settle_norm(x.item) = public.settle_norm(r.item)) then continue; end if;
      perform public.settle_insert_line(s.store_key, p_month, jsonb_build_object('kubun', r.kubun, 'item', r.item, 'amount', r.amount, 'tax', r.tax, 'note', r.note), actor->>'name');
      added := added || r.item;
    end loop;
    if array_length(added,1) > 0 then
      results := results || (s.name || ': ' || array_to_string(added, '、') || ' を追加');
      perform public.settle_log(actor, '定期費目セット', s.store_key, p_month, null, to_jsonb(added));
    end if;
  end loop;
  if array_length(results,1) is null then results := array['追加する定期費目はありませんでした（すべて入力済み）']; end if;
  return jsonb_build_object('ok', true, 'results', to_jsonb(results));
end $$;

-- 現金売上の取込の下見
create or replace function public.settle_cash_preview(actor jsonb, p_month text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.settle_require_hq(actor);
  return jsonb_build_object('month', p_month,
    'monthLabel', substring(p_month,1,4)::int || '年' || substring(p_month,6,2)::int || '月',
    'items', (select coalesce(jsonb_agg(jsonb_build_object('store', s.name, 'salesName', s.sales_name, 'amount', round(m.cash_total), 'days', coalesce(m.cash_days,0),
        'already', (select coalesce(jsonb_agg(l.item || '（¥' || to_char(l.amount,'FM999,999,999,990') || '）' order by l.id), '[]') from public.settle_lines l
                    where l.store_key = s.store_key and l.month = p_month and l.deleted_at is null and public.settle_norm(l.kubun) = '売上' and position('現金売上' in public.settle_norm(l.item)) > 0)) order by s.sort_order), '[]')
      from public.settle_stores s left join public.settle_sales_monthly m on m.sales_key = public.settle_norm(s.sales_name) and m.month = p_month));
end $$;

-- 現金売上の取込。既に行があれば上書き（重複を作らない）。p_skip_existing=true なら触らない
create or replace function public.settle_cash_apply(actor jsonb, p_month text, p_stores jsonb, p_skip_existing boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s record; amt numeric; ids bigint[]; item_name text; results text[] := '{}'; before jsonb;
begin
  perform public.settle_require_live(); perform public.settle_require_hq(actor);
  if coalesce(p_month,'') !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception '対象月の形式が不正です'; end if;
  item_name := substring(p_month,6,2)::int || '月現金売上';
  for s in select * from public.settle_stores where p_stores is null or p_stores ? name order by sort_order loop
    perform pg_advisory_xact_lock(hashtext('settle:' || s.store_key));
    if actor->>'role' <> 'マスター' and public.settle_is_locked(s.store_key, p_month) then results := results || (s.name || ': 🔒振込済みのためスキップ'); continue; end if;
    select array_agg(l.id order by l.legacy_row nulls last, l.id) into ids from public.settle_lines l
     where l.store_key = s.store_key and l.month = p_month and l.deleted_at is null and public.settle_norm(l.kubun) = '売上' and position('現金売上' in public.settle_norm(l.item)) > 0;
    if p_skip_existing and ids is not null then results := results || (s.name || ': 既に現金売上あり（スキップ）'); continue; end if;
    select round(m.cash_total) into amt from public.settle_sales_monthly m where m.sales_key = public.settle_norm(s.sales_name) and m.month = p_month;
    if amt is null then results := results || (s.name || ': 売上シートにデータなし'); continue; end if;
    if ids is not null then
      select to_jsonb(l) into before from public.settle_lines l where l.id = ids[1];
      update public.settle_lines set item = item_name, amount = amt, note = '分析_日別店舗より自動取込（更新）', editor = actor->>'name',
        entered_at = public.settle_today(), edited_at = public.settle_today() || ' ' || (actor->>'name'), updated_at = now() where id = ids[1];
      perform public.settle_log(actor, '現金売上の更新', s.store_key, p_month, before, jsonb_build_object('amount', amt));
      results := results || (s.name || ': ¥' || to_char(amt,'FM999,999,999,990') || ' に更新' || case when array_length(ids,1) > 1 then '　※他に' || (array_length(ids,1)-1) || '件の重複行あり・要確認' else '' end);
    else
      perform public.settle_insert_line(s.store_key, p_month, jsonb_build_object('kubun','売上','item',item_name,'amount',amt,'tax','10%','note','分析_日別店舗より自動取込'), actor->>'name');
      perform public.settle_log(actor, '現金売上の登録', s.store_key, p_month, null, jsonb_build_object('amount', amt));
      results := results || (s.name || ': ¥' || to_char(amt,'FM999,999,999,990') || ' を登録');
    end if;
  end loop;
  if array_length(results,1) is null then results := array['対象店舗がありません']; end if;
  return jsonb_build_object('ok', true, 'results', to_jsonb(results));
end $$;

-- 定期処理と通知に使う、全店舗のデータ（service_role のみ）
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
    'mode', coalesce((select value from public.settle_config where key = 'mode'), 'copy'))
$$;

-- 切り替え／切り戻し（担当者が社長の承認を受けて実行する）
create or replace function public.settle_set_mode(p_mode text, p_by text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if p_mode not in ('copy','live') then raise exception 'mode は copy か live'; end if;
  update public.settle_config set value = p_mode where key = 'mode';
  insert into public.settle_audit (actor, action, after) values (p_by, '切り替え', jsonb_build_object('mode', p_mode));
  return p_mode;
end $$;

revoke all on function public.settle_import(jsonb) from public, anon, authenticated;
grant execute on function public.settle_import(jsonb) to service_role;
revoke all on function public.settle_sales_push(jsonb) from public, anon, authenticated;
grant execute on function public.settle_sales_push(jsonb) to service_role;
revoke all on function public.settle_prepare_month(jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.settle_prepare_month(jsonb, text, boolean) to service_role;
revoke all on function public.settle_cash_preview(jsonb, text) from public, anon, authenticated;
grant execute on function public.settle_cash_preview(jsonb, text) to service_role;
revoke all on function public.settle_cash_apply(jsonb, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.settle_cash_apply(jsonb, text, jsonb, boolean) to service_role;
revoke all on function public.settle_system_data() from public, anon, authenticated;
grant execute on function public.settle_system_data() to service_role;
revoke all on function public.settle_set_mode(text, text) from public, anon, authenticated;
grant execute on function public.settle_set_mode(text, text) to service_role;
commit;

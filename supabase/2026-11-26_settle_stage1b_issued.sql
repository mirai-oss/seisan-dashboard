-- 移行 段階1の追加: 発行状況（✅）も取り込む
-- 元に戻す: alter table public.settle_stores drop column issued; のあと 2026-11-26_settle_stage1.sql の settle_import を再実行
begin;
alter table public.settle_stores add column if not exists issued jsonb not null default '{}'::jsonb;

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

revoke all on function public.settle_import(jsonb) from public, anon, authenticated;
grant execute on function public.settle_import(jsonb) to service_role;
commit;

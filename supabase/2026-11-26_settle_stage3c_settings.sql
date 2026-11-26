-- 移行 段階3-3（2026-11-26）: 設定（率・固定費の適用開始月、定期費目、メール、振込先）。保存は切り替え（mode='live'）まで断る。
begin;
create table if not exists public.settle_store_terms (
  id bigint generated always as identity primary key, store_key text not null, from_month text not null,
  rate_text text, rate_pct numeric not null, rent numeric not null default 0, insurance numeric not null default 0,
  accounting_fee numeric not null default 0, fixed4 numeric not null default 0, fixed5 numeric not null default 0,
  created_by text, created_at timestamptz not null default now(), unique (store_key, from_month));
alter table public.settle_store_terms enable row level security;
revoke all on public.settle_store_terms from public, anon, authenticated;
alter table public.settle_recurring_items add column if not exists start_month text;
alter table public.settle_recurring_items add column if not exists end_month text;
alter table public.settle_recurring_items add column if not exists deleted_at timestamptz;

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
    select a.*, coalesce(t.rate_pct, s.rate_pct) rate_pct,
      case when t.id is null then s.rent + s.insurance + s.accounting_fee + s.fixed4 + s.fixed5
           else t.rent + t.insurance + t.accounting_fee + t.fixed4 + t.fixed5 end fixed,
      case when a.m >= '2026-09' and a.m <= (select this_month from run) and coalesce(sm.pay_total,0) > 0
           then sm.pay_total else a.sales end roybase,
      coalesce((select p.client from public.settle_store_periods p where p.store_key = a.store_key and p.from_month <= a.m
                order by p.from_month desc, p.id limit 1), s.client, '') client
    from agg a
    join public.settle_stores s on s.store_key = a.store_key
    left join lateral (select * from public.settle_store_terms x where x.store_key = a.store_key and x.from_month <= a.m
                       order by x.from_month desc limit 1) t on true
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
  with s as (select public.settle_whoami(p_token) u),
  r as (select imported_at from public.settle_import_runs order by id desc limit 1)
  select jsonb_build_object(
    'user', s.u,
    'importedAt', r.imported_at,
    'data', jsonb_build_object(
      'stores',   (select coalesce(jsonb_agg(to_jsonb(t) - 'mail'), '[]') from public.settle_stores t),
      'terms',    (select coalesce(jsonb_agg(to_jsonb(t) order by t.store_key, t.from_month), '[]') from public.settle_store_terms t),
      'periods',  (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.settle_store_periods t),
      'lines',    (select coalesce(jsonb_agg(to_jsonb(t) order by t.store_key, t.legacy_row nulls last, t.id), '[]') from public.settle_lines t where t.deleted_at is null),
      'payments', (select coalesce(jsonb_agg(to_jsonb(t) order by t.seq), '[]') from public.settle_payment_events t),
      'logs',     (select coalesce(jsonb_agg(to_jsonb(t) order by t.seq), '[]') from public.settle_issue_logs t),
      'sales',    (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.settle_sales_monthly t),
      'corpRows', (select coalesce(jsonb_agg(t.cells order by t.row_no), '[]') from public.settle_sheet_rows t where t.sheet like '法人設定%')))
  from s, r where s.u is not null
$$;



-- 設定画面の表示に使うデータ（本部・マスターだけ）。パスワードは返さない
create or replace function public.settle_settings(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with u as (select public.settle_whoami(p_token) u)
  select case
    when u.u is null then null
    when u.u->>'role' not in ('本部','マスター') then jsonb_build_object('forbidden', true)
    else jsonb_build_object(
      'user', u.u,
      'stores',    (select coalesce(jsonb_agg(to_jsonb(t) order by t.sort_order), '[]') from public.settle_stores t),
      'terms',     (select coalesce(jsonb_agg(to_jsonb(t) order by t.store_key, t.from_month), '[]') from public.settle_store_terms t),
      'periods',   (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.settle_store_periods t),
      'recurring', (select coalesce(jsonb_agg(to_jsonb(t) order by t.store_key, t.id), '[]') from public.settle_recurring_items t where t.deleted_at is null),
      'accounts',  (select coalesce(jsonb_agg(jsonb_build_object('id', a.login_id, 'hasPw', a.pw_hash <> '', 'name', a.name, 'role', a.role,
                      'stores', a.stores_raw, 'enabled', a.enabled, 'email', a.email) order by a.sort_order, a.login_id), '[]') from public.settle_accounts a),
      'corpRows',  (select coalesce(jsonb_agg(t.cells order by t.row_no), '[]') from public.settle_sheet_rows t where t.sheet like '法人設定%'),
      'ops', jsonb_build_object('lockLevel', coalesce((select value from public.settle_config where key = 'lock_level'), 'master'),
                                'autoSendMode', coalesce((select value from public.settle_config where key = 'autosend_mode'), 'manual')))
  end from u
$$;

create or replace function public.settle_require_master(actor jsonb) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if coalesce(actor->>'role','') <> 'マスター' then raise exception 'この操作はマスターアカウントのみ実行できます'; end if;
end $$;

-- 振込済みの月にかかる条件の変更はさせない
create or replace function public.settle_check_terms_month(p_key text, p_from text) returns void
language plpgsql stable security definer set search_path = '' as $$
declare bad text;
begin
  select string_agg(m, '・' order by m) into bad from (
    select distinct month m from public.settle_payment_events where month >= p_from) q
  where public.settle_is_locked(p_key, q.m);
  if bad is not null then raise exception '% 分は振込済みのため、その月にかかる変更はできません。開始月を後ろの月にしてください', bad; end if;
end $$;

-- ロイヤリティ率と固定費（適用開始月つき）。開始月より前の月は変わらない
create or replace function public.settle_save_terms(actor jsonb, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text; m text := p->>'from'; rate numeric; v numeric[]; f text; before jsonb; i int := 0;
begin
  perform public.settle_require_live(); perform public.settle_require_master(actor);
  k := public.settle_key_of(p->>'store');
  if coalesce(m,'') !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception '適用開始月を選んでください'; end if;
  rate := public.settle_amount(regexp_replace(coalesce(p->>'rate',''), '[%％]', '', 'g'));
  if rate is null or rate < 0 or rate > 100 then raise exception 'ロイヤリティ率は 0〜100 の数字で入力してください'; end if;
  foreach f in array array['rent','ins','sss','f4','f5'] loop
    i := i + 1; v[i] := public.settle_amount(coalesce(nullif(p->>f,''),'0'));
    if v[i] is null or v[i] < 0 then raise exception '固定費は 0 以上の数字で入力してください'; end if;
  end loop;
  perform pg_advisory_xact_lock(hashtext('settle:' || k));
  perform public.settle_check_terms_month(k, m);
  select to_jsonb(t) into before from public.settle_store_terms t where store_key = k and from_month = m;
  insert into public.settle_store_terms (store_key, from_month, rate_text, rate_pct, rent, insurance, accounting_fee, fixed4, fixed5, created_by)
  values (k, m, rate::text || '%', rate, v[1], v[2], v[3], v[4], v[5], actor->>'name')
  on conflict (store_key, from_month) do update set rate_text = excluded.rate_text, rate_pct = excluded.rate_pct, rent = excluded.rent,
    insurance = excluded.insurance, accounting_fee = excluded.accounting_fee, fixed4 = excluded.fixed4, fixed5 = excluded.fixed5,
    created_by = excluded.created_by, created_at = now();
  perform public.settle_log(actor, '率・固定費の設定', k, m, before, p);
  return jsonb_build_object('ok', true, 'store', p->>'store', 'from', m);
end $$;

create or replace function public.settle_delete_terms(actor jsonb, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.settle_store_terms;
begin
  perform public.settle_require_live(); perform public.settle_require_master(actor);
  select * into t from public.settle_store_terms where id = (p->>'id')::bigint;
  if t.id is null then raise exception '対象の設定が見つかりません'; end if;
  perform pg_advisory_xact_lock(hashtext('settle:' || t.store_key));
  perform public.settle_check_terms_month(t.store_key, t.from_month);
  delete from public.settle_store_terms where id = t.id;
  perform public.settle_log(actor, '率・固定費の設定の取り消し', t.store_key, t.from_month, to_jsonb(t), null);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.settle_save_recurring(actor jsonb, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text; amt numeric := public.settle_amount(p->>'amount'); rid bigint := nullif(p->>'id','')::bigint; before jsonb;
  s text := nullif(p->>'startMonth',''); e text := nullif(p->>'endMonth','');
begin
  perform public.settle_require_live(); perform public.settle_require_hq(actor);
  if coalesce((p->>'delete')::boolean, false) then
    update public.settle_recurring_items set deleted_at = now() where id = rid and deleted_at is null returning to_jsonb(settle_recurring_items) into before;
    if before is null then raise exception '該当する定期費目が見つかりません'; end if;
    perform public.settle_log(actor, '定期費目の削除', before->>'store_key', null, before, null);
    return jsonb_build_object('ok', true);
  end if;
  k := public.settle_key_of(p->>'store');
  if btrim(coalesce(p->>'item','')) = '' then raise exception '費目名を入力してください'; end if;
  if amt is null then raise exception '金額が数値ではありません'; end if;
  if (s is not null and s !~ '^\d{4}-(0[1-9]|1[0-2])$') or (e is not null and e !~ '^\d{4}-(0[1-9]|1[0-2])$') then raise exception '月の形式が不正です'; end if;
  if s is not null and e is not null and s > e then raise exception '開始月が終了月より後になっています'; end if;
  if rid is null then
    insert into public.settle_recurring_items (store_key, kubun, item, amount, tax, note, status, start_month, end_month)
    values (k, coalesce(nullif(p->>'kubun',''),'変動費'), btrim(p->>'item'), amt, coalesce(nullif(p->>'tax',''),'10%'), coalesce(p->>'note',''),
            case when p->>'status' = '停止' then '停止' else '有効' end, s, e) returning id into rid;
  else
    select to_jsonb(r) into before from public.settle_recurring_items r where id = rid and deleted_at is null;
    if before is null then raise exception '該当する定期費目が見つかりません'; end if;
    update public.settle_recurring_items set store_key = k, kubun = coalesce(nullif(p->>'kubun',''),'変動費'), item = btrim(p->>'item'), amount = amt,
      tax = coalesce(nullif(p->>'tax',''),'10%'), note = coalesce(p->>'note',''), status = case when p->>'status' = '停止' then '停止' else '有効' end,
      start_month = s, end_month = e where id = rid;
  end if;
  perform public.settle_log(actor, '定期費目の保存', k, null, before, p);
  return jsonb_build_object('ok', true, 'id', rid);
end $$;

create or replace function public.settle_save_mail(actor jsonb, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text; before jsonb; a text; addr text;
begin
  perform public.settle_require_live(); perform public.settle_require_hq(actor);
  k := public.settle_key_of(p->>'store');
  foreach a in array array[coalesce(p->>'to',''), coalesce(p->>'cc','')] loop
    foreach addr in array regexp_split_to_array(a, '\s*[,、，;]\s*') loop
      if btrim(addr) <> '' and btrim(addr) !~ '^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$' then raise exception 'メールアドレスの形が正しくありません: %', addr; end if;
    end loop;
  end loop;
  select mail into before from public.settle_stores where store_key = k;
  update public.settle_stores set mail = jsonb_build_object('to', btrim(coalesce(p->>'to','')), 'cc', btrim(coalesce(p->>'cc','')),
    'subject', coalesce(p->>'subject',''), 'body', coalesce(p->>'body','')) where store_key = k;
  perform public.settle_log(actor, 'メール設定の保存', k, null, before, p);
  return jsonb_build_object('ok', true, 'store', p->>'store');
end $$;

create or replace function public.settle_save_corp(actor jsonb, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c text := btrim(coalesce(p->>'client','')); sh text; n int; before jsonb; v_cells jsonb;
begin
  perform public.settle_require_live(); perform public.settle_require_hq(actor);
  if c = '' then raise exception '法人名が空です'; end if;
  perform pg_advisory_xact_lock(hashtext('settle:corp'));
  sh := coalesce((select sheet from public.settle_sheet_rows where sheet like '法人設定%' limit 1), '法人設定_精算ダッシュボード');
  v_cells := jsonb_build_array(c, btrim(coalesce(p->>'account','')), btrim(coalesce(p->>'note','')));
  select r.row_no, r.cells into n, before from public.settle_sheet_rows r
   where r.sheet = sh and r.row_no > 1 and public.settle_norm(r.cells->>0) = public.settle_norm(c) order by r.row_no limit 1;
  if n is null then
    if not exists (select 1 from public.settle_sheet_rows where sheet = sh) then
      insert into public.settle_sheet_rows values (sh, 1, '["委託先（法人名）","振込先口座","備考"]');
    end if;
    insert into public.settle_sheet_rows select sh, max(row_no) + 1, v_cells from public.settle_sheet_rows where sheet = sh;
  else
    update public.settle_sheet_rows r set cells = v_cells where r.sheet = sh and r.row_no = n;
  end if;
  perform public.settle_log(actor, '振込先の保存', null, null, before, p);
  return jsonb_build_object('ok', true, 'client', c, 'updated', n is not null);
end $$;

create or replace function public.settle_save_ops(actor jsonb, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l text := case when p->>'lockLevel' = 'admin' then 'admin' else 'master' end;
  a text := case when p->>'autoSendMode' = 'auto' then 'auto' else 'manual' end;
begin
  perform public.settle_require_live(); perform public.settle_require_master(actor);
  insert into public.settle_config values ('lock_level', l), ('autosend_mode', a) on conflict (key) do update set value = excluded.value;
  perform public.settle_log(actor, '運用設定の保存', null, null, null, p);
  return jsonb_build_object('ok', true, 'lockLevel', l, 'autoSendMode', a);
end $$;

revoke all on function public.settle_calc() from public, anon, authenticated;
grant execute on function public.settle_calc() to service_role;
revoke all on function public.settle_read(text) from public, anon, authenticated;
grant execute on function public.settle_read(text) to service_role;
revoke all on function public.settle_settings(text) from public, anon, authenticated;
grant execute on function public.settle_settings(text) to service_role;
revoke all on function public.settle_require_master(jsonb) from public, anon, authenticated;
grant execute on function public.settle_require_master(jsonb) to service_role;
revoke all on function public.settle_check_terms_month(text, text) from public, anon, authenticated;
grant execute on function public.settle_check_terms_month(text, text) to service_role;
revoke all on function public.settle_save_terms(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.settle_save_terms(jsonb, jsonb) to service_role;
revoke all on function public.settle_delete_terms(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.settle_delete_terms(jsonb, jsonb) to service_role;
revoke all on function public.settle_save_recurring(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.settle_save_recurring(jsonb, jsonb) to service_role;
revoke all on function public.settle_save_mail(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.settle_save_mail(jsonb, jsonb) to service_role;
revoke all on function public.settle_save_corp(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.settle_save_corp(jsonb, jsonb) to service_role;
revoke all on function public.settle_save_ops(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.settle_save_ops(jsonb, jsonb) to service_role;
commit;

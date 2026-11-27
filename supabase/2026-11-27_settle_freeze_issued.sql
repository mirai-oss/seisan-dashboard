-- 2026-11-27 担当C（社長承認）: 精算書を発行（メール送信）した月・振込済みの月は、請求書の側（自動連携）から追加・変更・削除できないようにする。
-- 画面（精算ダッシュボード）での手入力・修正は今まで通り。戻し: 2026-11-26_settle_stage3a_write.sql の2関数を適用し直す。
begin;
create or replace function public.settle_frozen_reason(p_key text, p_month text) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if public.settle_is_locked(p_key, p_month) then return p_month || '分は振込済みです。'; end if;
  if exists (select 1 from public.settle_issue_logs i join public.settle_stores s on s.name = i.store
             where s.store_key = p_key and i.month = p_month and i.action = 'メール送信') then
    return p_month || '分の精算書は発行（送信）済みです。';
  end if;
  return null;
end $$;

create or replace function public.settle_ext_remove(p_store text, p_month text, p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text; n int; why text;
begin
  perform public.settle_require_live();
  k := public.settle_key_of(p_store);
  perform pg_advisory_xact_lock(hashtext('settle:' || k));
  -- 消す行が無ければ、そのまま「該当なし」（行が無いのに確定済みで止めない）
  if not exists (select 1 from public.settle_lines where store_key = k and month = p_month and ext_ref = p_key and deleted_at is null) then
    return jsonb_build_object('removed', false, 'reason', '該当行が見つかりませんでした（既に削除済みの可能性）');
  end if;
  why := public.settle_frozen_reason(k, p_month);
  if why is not null then
    return jsonb_build_object('removed', false, 'locked', true, 'reason', why || '直す場合は精算ダッシュボードで確認して行ってください。');
  end if;
  update public.settle_lines set deleted_at = now(), deleted_by = '自動連携' where store_key = k and month = p_month and ext_ref = p_key and deleted_at is null;
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('removed', false, 'reason', '該当行が見つかりませんでした（既に削除済みの可能性）'); end if;
  perform public.settle_log(jsonb_build_object('name','自動連携'), '外部明細の削除', k, p_month, jsonb_build_object('extRef', p_key, 'rows', n), null);
  return jsonb_build_object('removed', true, 'rows', n);
end $$;

create or replace function public.settle_ext_upsert(p_store text, p_month text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text; src text := left(btrim(coalesce(p->>'sourceKey','')), 200); amt numeric := public.settle_amount(p->>'amount');
  why text; locked_old text; old_month text; l public.settle_lines; prev text := btrim(coalesce(p->>'previousStore','')); updated boolean := false;
begin
  perform public.settle_require_live();
  if coalesce(p_month,'') !~ '^\d{4}-(0[1-9]|1[0-2])$' then return jsonb_build_object('ok', false, 'error', '年月が不正です'); end if;
  if btrim(coalesce(p->>'item','')) = '' then return jsonb_build_object('ok', false, 'error', '費目名（item）が空です'); end if;
  if amt is null or amt < 0 then return jsonb_build_object('ok', false, 'error', '金額が不正です'); end if;
  if src = '' then return jsonb_build_object('ok', false, 'error', 'sourceKey（冪等キー）が空です'); end if;
  k := public.settle_key_of(p_store);
  perform pg_advisory_xact_lock(hashtext('settle:' || k));
  why := public.settle_frozen_reason(k, p_month);
  if why is not null then
    return jsonb_build_object('ok', false, 'locked', true, 'error', why || '請求書の側からは追加・変更できません。必要な場合は精算ダッシュボードで入力してください。');
  end if;
  -- 同じ明細が、確定済みの別の月・別の店舗に入っている場合も止める（移し替えると二重や消し漏れになる）
  select string_agg(distinct x.month, '・') into locked_old from public.settle_lines x
   where x.ext_ref = src and x.deleted_at is null and not (x.store_key = k and x.month = p_month)
     and public.settle_frozen_reason(x.store_key, x.month) is not null;
  if locked_old is not null then
    return jsonb_build_object('ok', false, 'locked', true, 'error', 'この明細は ' || locked_old || '分（発行済みまたは振込済み）に登録されているため移せません。精算ダッシュボードで確認してください。');
  end if;
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

revoke all on function public.settle_frozen_reason(text, text), public.settle_ext_remove(text, text, text), public.settle_ext_upsert(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.settle_frozen_reason(text, text), public.settle_ext_remove(text, text, text), public.settle_ext_upsert(text, text, jsonb) to service_role;
commit;

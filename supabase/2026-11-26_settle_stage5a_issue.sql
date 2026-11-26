-- 移行 段階3-5a（2026-11-26）: 発行・送信の記録と、発行に必要な読み取り。切り替えまで書き込みは断る。
begin;
-- 発行に使うデータ（画面表示と同じ内容に、メール設定と発行元の設定を足す）
create or replace function public.settle_issue_data(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when r is null then null else
    jsonb_set(jsonb_set(r, '{data,settings}', coalesce((select settings from public.settle_import_runs order by id desc limit 1), '{}')),
      '{data,stores}', (select coalesce(jsonb_agg(to_jsonb(t) order by t.sort_order), '[]') from public.settle_stores t))
  end from (select public.settle_read(p_token) r) q
$$;

-- 発行・送信の記録を1行足す。メール送信なら「発行済み」の印も付ける
create or replace function public.settle_record_issue(actor jsonb, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  perform public.settle_require_live(); perform public.settle_require_hq(actor);
  k := public.settle_key_of(p->>'store');
  perform pg_advisory_xact_lock(hashtext('settle:issue'));
  insert into public.settle_issue_logs (seq, logged_at, action, store, month, file_name, file_id, url, who, sent_to)
  values (coalesce((select max(seq) from public.settle_issue_logs), 0) + 1, to_char(now() at time zone 'Asia/Tokyo','YYYY-MM-DD HH24:MI:SS'),
          p->>'action', p->>'store', p->>'month', p->>'fileName', p->>'fileId', '', actor->>'name', coalesce(p->>'to',''));
  if p->>'action' = 'メール送信' then
    update public.settle_stores set issued = coalesce(issued,'{}'::jsonb) || jsonb_build_object(p->>'month', true) where store_key = k;
  end if;
end $$;

revoke all on function public.settle_issue_data(text), public.settle_record_issue(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.settle_issue_data(text), public.settle_record_issue(jsonb, jsonb) to service_role;
commit;

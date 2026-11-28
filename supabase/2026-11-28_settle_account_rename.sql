-- 担当C 2026-11-28: 精算の科目名をMF・PLに合わせる（消耗品・備品費→備品・消耗品費／仕入（食材・飲料）→仕入高）。金額は変えない
begin;
do $$
declare before_t jsonb; after_t jsonb;
begin
  select jsonb_agg(jsonb_build_array(store_key,month,transfer,cnt) order by store_key,month) into before_t from public.settle_calc();
  update public.settle_lines set account = case account when '仕入（食材・飲料）' then '仕入高' else '備品・消耗品費' end, updated_at = now() where account in ('仕入（食材・飲料）','消耗品・備品費');
  update public.settle_pl_mappings set account = case account when '仕入（食材・飲料）' then '仕入高' else '備品・消耗品費' end where account in ('仕入（食材・飲料）','消耗品・備品費');
  select jsonb_agg(jsonb_build_array(store_key,month,transfer,cnt) order by store_key,month) into after_t from public.settle_calc();
  if before_t is distinct from after_t then raise exception '金額が変わるため中止'; end if;
end $$;
commit;

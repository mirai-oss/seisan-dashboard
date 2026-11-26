// 設定画面のデータ（今のGASの sd_getSettings と同じ形に、適用開始月つきの条件とメール設定を足したもの）
import { norm, termsAt } from './dashboard.ts';

const money = (s: any) => ({ rate: s.rate_text ?? '', rent: Number(s.rent), ins: Number(s.insurance), sss: Number(s.accounting_fee), f4: Number(s.fixed4), f5: Number(s.fixed5) });

export function buildSettings(d: any, thisMonth: string) {
  const stores = [...d.stores].sort((a, b) => a.sort_order - b.sort_order);
  const corpInfo = new Map<string, string[]>((d.corpRows || []).slice(1).map((r: string[]) => [norm(r[0]), r]));
  const seen = new Set<string>(), corps: any[] = [];
  for (const c of [...stores.map((s) => s.client), ...d.periods.map((p: any) => p.client)]) {
    if (!c || seen.has(norm(c))) continue;
    seen.add(norm(c));
    const r = corpInfo.get(norm(c));
    corps.push({ client: c, account: String(r?.[1] ?? ''), note: String(r?.[2] ?? '') });
  }
  const nameOf = new Map(stores.map((s) => [s.store_key, s.name]));
  return {
    accounts: d.accounts.map((a: any) => ({ ...a, pw: '' })),
    corps,
    stores: stores.map((s) => {
      const cur = termsAt(s, thisMonth, d.terms);
      return {
        name: s.name, client: s.client ?? '', rate: cur.rate_text ?? '', hasDb: !!s.db_sheet,
        base: money(s), current: money(cur),
        terms: d.terms.filter((t: any) => t.store_key === s.store_key).map((t: any) => ({ id: t.id, from: t.from_month, by: t.created_by ?? '', ...money(t) })),
        mail: { to: s.mail?.to ?? '', cc: s.mail?.cc ?? '', subject: s.mail?.subject ?? '', body: s.mail?.body ?? '' },
      };
    }),
    recur: d.recurring.map((r: any) => ({
      id: r.id, store: nameOf.get(r.store_key) ?? r.store_key, kubun: r.kubun ?? '変動費', item: r.item ?? '', amount: Number(r.amount),
      tax: r.tax ?? '10%', note: r.note ?? '', status: r.status === '停止' ? '停止' : '有効', startMonth: r.start_month ?? '', endMonth: r.end_month ?? '',
    })),
    ops: d.ops,
    masterSheetUrl: '',
  };
}

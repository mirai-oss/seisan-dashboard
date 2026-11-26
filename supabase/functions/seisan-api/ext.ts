// 外の仕組み（請求書・経営ダッシュボード・日次取込）が呼ぶ受け口。今のGASの sd_api* と同じ名前・同じ戻り値。
import { ACCOUNT_LIST, norm, settle, termsAt, ROYALTY_ACTUAL_FROM } from './dashboard.ts';

const GUESS: [RegExp, string][] = [
  [/電気|ガス|水道/, '水道光熱費'], [/インターネット|電話|通信|プロバイダ/, '通信費'],
  [/家賃|賃料/, '家賃'], [/リース/, 'リース料'],
  [/広告|求人|採用媒体/, '広告宣伝費'], [/販促|クーポン|チラシ/, '販売促進費'],
  [/仕入|食材|飲料|GOSSO/, '仕入（食材・飲料）'], [/清掃|衛生|害虫/, '衛生管理費'],
  [/修繕|修理/, '修繕費'], [/カード手数料|決済手数料/, 'カード手数料'], [/振込手数料|銀行手数料/, '支払手数料'],
  [/税理士|社労士|顧問料|報酬/, '支払報酬料'], [/研修|教育/, '採用教育費'],
  [/接待|交際/, '接待交際費'], [/会議|打合せ/, '会議費'], [/保険/, '保険料'],
  [/租税|税金|印紙/, '租税公課'], [/福利厚生/, '福利厚生費'], [/会費/, '諸会費'],
  [/消耗品|備品/, '消耗品・備品費'],
];
export const guessAccount = (item: unknown) => GUESS.find(([re]) => re.test(String(item ?? '')))?.[1] ?? '';
const t = (v: unknown) => String(v ?? '').trim();

// 費目名を入れたときの勘定科目の提案（今の sd_suggestAccount と同じ: その店舗で前に使った科目 → 費目名からの推定）
export function suggestAccount(d: any, store: string, item: string) {
  const st = d.stores.find((s: any) => s.name === store);
  const hist = st ? d.lines.filter((l: any) => l.store_key === st.store_key && norm(l.item) === norm(item) && l.account && l.account !== '対象外') : [];
  if (hist.length) { const last = hist[hist.length - 1]; return { account: last.account, subAccount: last.sub_account || '', source: 'history' }; }
  const g = guessAccount(item);
  return { account: g, subAccount: '', source: g ? 'guess' : (st ? 'none' : 'guess') };
}

export function resolveMapping(d: any, store: string, mfAccount: string, mfSub: string, vendor: string, item: string) {
  if (mfAccount) {
    const rows = d.mappings.filter((r: any) => r.mf_account === mfAccount && (!r.mf_sub || r.mf_sub === mfSub));
    const hit = (vendor && rows.find((r: any) => r.vendor === vendor)) || rows.find((r: any) => !r.vendor);
    if (hit) return { account: hit.on_off ? hit.account : '対象外', source: hit.vendor ? 'mapping-vendor' : 'mapping-general' };
  }
  const st = d.stores.find((s: any) => s.name === store);
  if (st && item) {
    const hist = d.lines.filter((l: any) => l.store_key === st.store_key && norm(l.item) === norm(item) && l.account && l.account !== '対象外');
    if (hist.length) return { account: hist[hist.length - 1].account, source: 'history' };
  }
  if (mfAccount && ACCOUNT_LIST.includes(mfAccount)) return { account: mfAccount, source: 'name-match' };
  const g = guessAccount(item);
  return g ? { account: g, source: 'keyword' } : null;
}

export function isLocked(d: any, st: any, month: string) {
  let period: any = null;
  for (const p of d.periods) if (p.store_key === st.store_key && p.from_month <= month && (!period || p.from_month > period.from_month)) period = p;
  const client = (period ? period.client : st.client) || '（委託先未設定）';
  const last = (key: string) => d.payments.filter((e: any) => e.target_key === key && e.month === month).sort((a: any, b: any) => a.seq - b.seq).pop();
  return !!(last(norm(client)) ?? last(st.store_key))?.done;
}
const rowsOf = (d: any, st: any) => d.lines.filter((l: any) => l.store_key === st.store_key && !l.deleted_at);
const settleOf = (d: any, st: any, month: string, thisMonth: string) => {
  const rows = rowsOf(d, st).filter((l: any) => l.month === month);
  const sale = d.sales.find((x: any) => x.month === month && x.sales_key === norm(st.sales_name));
  const reg = st.sales_name && month >= ROYALTY_ACTUAL_FROM && month <= thisMonth && Number(sale?.pay_total ?? 0) > 0 ? Number(sale.pay_total) : null;
  return settle(rows, month, termsAt(st, month, d.terms), reg);
};

export function transferEx(d: any, store: string, month: string, thisMonth: string) {
  const st = d.stores.find((s: any) => s.name === store);
  if (!st) return { found: false, reason: '店舗マスタに「' + store + '」という名前が見つかりません（表記ゆれの可能性）', masterNames: d.stores.map((s: any) => s.name) };
  const s = settleOf(d, st, month, thisMonth);
  if (!s.hasSales) return { found: true, hasSales: false, reason: month + '分の売上行が0件でした', rowCountAllMonths: rowsOf(d, st).length };
  if (!isLocked(d, st, month)) return { found: true, hasSales: true, paid: false, reason: month + '分はまだ振込済みではありません（未確定のためPL反映対象外）', transferEx: s.transferEx, transfer: s.transfer };
  return { found: true, hasSales: true, paid: true, transferEx: s.transferEx, transfer: s.transfer };
}

export function categorizedLines(d: any, store: string, month: string) {
  const st = d.stores.find((s: any) => s.name === store);
  if (!st) return { found: false, reason: '店舗マスタに「' + store + '」という名前が見つかりません' };
  const rows = rowsOf(d, st).filter((l: any) => l.month === month);
  if (!rows.length) return { found: true, hasSales: false, reason: month + '分の明細が0件でした' };
  if (!isLocked(d, st, month)) return { found: true, hasSales: true, paid: false, reason: month + '分はまだ振込済みではありません（未確定のためPL反映対象外）', lines: [] };
  const rate: Record<string, number> = { '10%': 1.1, '8%': 1.08, '非課税': 1 };
  const agg = new Map<string, number>();
  for (const r of rows) {
    const account = t(r.account);
    if (!account || account === '対象外' || account === '運営委託費') continue;
    if (t(r.kubun) === '売上' || account === '売上高' || account === 'その他売上') continue;
    const key = account + '\t' + t(r.sub_account);
    agg.set(key, (agg.get(key) || 0) + (Number(r.amount) || 0) / (rate[norm(r.tax)] || 1.1));
  }
  return { found: true, hasSales: true, paid: true, lines: [...agg].map(([k, v]) => { const [account, subAccount] = k.split('\t'); return { account, subAccount, amountEx: Math.round(v) }; }) };
}

export function getLines(d: any, items: any[]) {
  const lines = items.map((it) => {
    const base = { store: it.store, monthKey: it.monthKey, sourceKey: it.sourceKey };
    const st = d.stores.find((s: any) => s.name === it.store);
    if (!st) return { ...base, found: false, error: '店舗が見つかりません' };
    const mine = rowsOf(d, st).filter((l: any) => l.month === it.monthKey);
    const row = mine.find((l: any) => l.ext_ref === it.sourceKey) ?? mine.find((l: any) => !l.ext_ref && l.note === '外部連携:' + it.sourceKey);
    if (!row) return { ...base, found: false };
    const locked = isLocked(d, st, it.monthKey), log = d.plLogs.find((g: any) => g.store === it.store && g.month === it.monthKey);
    const plStatus = !row.account ? 'PL科目未設定' : row.account === '対象外' ? 'PL対象外' : !locked ? '振込確定待ち' : !log ? 'PL同期待ち' : !log.ok ? 'PLエラー' : '店舗月次PL同期実行済み（個別反映未検証）';
    return { ...base, found: true, item: row.item, amount: Number(row.amount), tax: row.tax, account: row.account ?? '', subAccount: row.sub_account ?? '', note: row.note ?? '', locked, plStatus };
  });
  return { ok: true, lines };
}

export function debugExtRef(d: any, store: string, month: string) {
  const st = d.stores.find((s: any) => s.name === store);
  if (!st) return { ok: false, error: '店舗が見つかりません: ' + store };
  return { ok: true, colMap: {}, rows: rowsOf(d, st).filter((l: any) => l.month === month).map((r: any) => {
    const ref = r.ext_ref ?? '';
    return { row: r.id, item: r.item, account: r.account ?? '', extRef: ref, extRefLen: ref.length, extRefCharCodes: [...ref].map((c: string) => c.charCodeAt(0)), note: r.note ?? '' };
  }) };
}

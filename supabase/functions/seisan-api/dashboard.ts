// 精算ダッシュボードの画面データを、移行用の表の内容から組み立てる（GASの sd_buildDashboard_ と同じ形・同じ計算）。
// 通信もデータベースも触らない純粋な関数。手元のテストと、Supabaseの関数の両方から使う。

export const START_MONTH = '2026-03';
export const ROYALTY_ACTUAL_FROM = '2026-09';
export const NO_CLIENT = '（委託先未設定）';
export const TAX_OPTIONS = ['10%', '8%', '対象外'];
export const KUBUN_OPTIONS = ['売上', '変動費', '固定ロイヤリティ', '変動ロイヤリティ', '固定調整'];
export const ACCOUNT_LIST = [
  '対象外',
  '役員報酬', '法定福利費', '通勤手当', '旅費交通費', '賞与積立', '退職金等',
  '家賃', 'リース料', '家賃更新按分', '広告宣伝費', '販売促進費',
  '水道光熱費', '通信費', '備品・消耗品費', '修繕費', '衛生管理費', 'カード手数料', '支払手数料',
  '支払報酬料', '採用教育費', '接待交際費', '会議費', '慶弔見舞費', '保険料', '租税公課',
  '減価償却費', '福利厚生費', '諸会費', '雑費', '本部経費（按分）',
  'その他売上', '銀行返済', '仕入高', '運営委託費',
  '業務委託料',
];

export const norm = (s: unknown) => String(s ?? '').replace(/[\s　]+/g, '').replace(/％/g, '%');

export function addMonths(key: string, n: number) {
  const [y, m] = key.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

export function monthList(anchor: string, thisMonth: string) {
  const end = addMonths(anchor && anchor > thisMonth ? anchor : thisMonth, 6);
  const out: string[] = [];
  for (let k = START_MONTH; k <= end && out.length < 240; k = addMonths(k, 1)) out.push(k);
  return out.length ? out : [START_MONTH];
}

export type User = { name: string; role: string; storesRaw?: string };
export type Data = {
  stores: any[]; periods: any[]; lines: any[]; payments: any[]; logs: any[]; sales: any[];
  corpRows: string[][]; thisMonth: string; terms?: any[];
};

// 対象月の条件（率・固定費）。適用開始月つきの設定があれば、その月に有効な最も新しいもの。無ければ店舗の元の値
const TERM_KEYS = ['rate_text', 'rate_pct', 'rent', 'insurance', 'accounting_fee', 'fixed4', 'fixed5'] as const;
export function termsAt(st: any, month: string, terms: any[] = []) {
  let best: any = null;
  for (const t of terms) if (t.store_key === st.store_key && t.from_month <= month && (!best || t.from_month > best.from_month)) best = t;
  return best ? { ...st, ...Object.fromEntries(TERM_KEYS.map((k) => [k, best[k]])) } : st;
}

export function allowedStores(user: User, stores: any[]) {
  if (user.role === '本部' || norm(user.storesRaw) === '全店' || !user.storesRaw) return stores;
  const names = String(user.storesRaw).split(/[,、，]/).map(norm).filter(Boolean);
  return stores.filter((s) => names.includes(norm(s.name)));
}

function clientAt(st: any, month: string, periods: any[]) {
  let best: any = null;
  for (const p of periods) {
    if (p.store_key === st.store_key && p.from_month <= month && (!best || p.from_month > best.from_month)) best = p;
  }
  return best ? best.client : (st.client ?? '');
}

function paidMap(events: any[]) {
  const out: Record<string, Record<string, any>> = {};
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const byMonth = (out[e.target_key] ||= {});
    const cur = byMonth[e.month] || { done: false, date: '', by: '', total: 0 };
    cur.done = !!e.done; cur.date = e.paid_date ?? ''; cur.by = e.recorded_by ?? '';
    if (e.done && Number(e.amount)) cur.total += Number(e.amount);
    byMonth[e.month] = cur;
  }
  return out;
}

function sentMap(logs: any[]) {
  const out: Record<string, Record<string, any>> = {};
  for (const r of [...logs].sort((a, b) => a.seq - b.seq)) {
    if (r.action !== 'メール送信' && r.action !== 'PDF保存') continue;
    const m = (out[norm(r.store)] ||= {});
    const at = r.logged_at ?? '';
    const prev = m[r.month];
    if (!prev || at > prev.at || (r.action === 'メール送信' && prev.action !== 'メール送信')) {
      m[r.month] = { at, action: r.action, fileId: r.file_id ?? '', fileName: r.file_name ?? '', to: r.sent_to ?? '' };
    }
  }
  return out;
}

export function settle(rows: any[], month: string, st: any, registerSales: number | null) {
  const rate = Number(st.rate_pct || 0) / 100;
  const fixedTotal = ['rent', 'insurance', 'accounting_fee', 'fixed4', 'fixed5'].reduce((a, k) => a + Number(st[k] || 0), 0);
  let sales = 0, varCost = 0, royF = 0, royVarDb = 0, adj = 0, count = 0;
  for (const r of rows) {
    count++;
    const k = norm(r.kubun), a = Number(r.amount);
    if (k === '売上') sales += a;
    else if (k === '固定ロイヤリティ') royF += a;
    else if (k === '変動ロイヤリティ') royVarDb += a;
    else if (k === '固定調整') adj += a;
    else varCost += a;
  }
  const royBase = registerSales != null ? registerSales : sales;
  const royV = Math.round(royBase * rate);
  const fixedSub = fixedTotal + adj;
  const costTotal = fixedSub + varCost + royF + royV;
  const transfer = sales - costTotal;
  const transferEx = Math.round(transfer / 1.1);
  return {
    sales, varCost, royF, royV, royVarDb, royBase, royBaseActual: registerSales != null, adj, fixedSub, costTotal,
    transfer, transferEx, tax: transfer - transferEx, ns: royF + royV, hasSales: sales > 0, count,
  };
}

function missing(byMonth: Record<string, any[]>, month: string, required: string[]) {
  const cur = new Set<string>(), curKubun = new Set<string>();
  for (const r of byMonth[month] || []) { cur.add(norm(r.item)); curKubun.add(norm(r.kubun)); }
  const prev = [addMonths(month, -1), addMonths(month, -2), addMonths(month, -3)];
  const cnt = new Map<string, number>(), label = new Map<string, string>();
  for (const pk of prev) {
    const seen = new Set<string>();
    for (const r of byMonth[pk] || []) {
      const n = norm(r.item);
      if (!n || seen.has(n)) continue;
      seen.add(n); cnt.set(n, (cnt.get(n) || 0) + 1); label.set(n, r.item);
    }
  }
  const out: string[] = [];
  for (const [n, c] of cnt) if (c >= 2 && !cur.has(n)) out.push(label.get(n)!);
  for (const x of required || []) {
    const n = norm(x);
    if (!n || cur.has(n)) continue;
    const lb = label.get(n) || x;
    if (!out.includes(lb)) out.push(lb);
  }
  const catWarn: string[] = [];
  for (const k of ['売上', '固定ロイヤリティ']) {
    const had = prev.some((pk) => (byMonth[pk] || []).some((r) => norm(r.kubun) === k));
    if (had && !curKubun.has(k)) catWarn.push('区分「' + k + '」が未入力');
  }
  out.sort();
  return { missing: out, catWarn };
}

export function dupSuspects(rows: any[], isLocked: (m: string) => boolean) {
  const groups = new Map<string, { reason: string; rows: any[] }>();
  const add = (key: string, reason: string, r: any) => { if (!groups.has(key)) groups.set(key, { reason, rows: [] }); groups.get(key)!.rows.push(r); };
  for (const r of rows) {
    const amount = Number(r.amount);
    if (r.month < START_MONTH || !amount) continue;
    const ref = String(r.ext_ref || '');
    if (ref) add('ref|' + ref, '同じ連携元の明細が2件あります', r);
    const m = ref.match(/^invoice:([^:]+):/);
    if (m) add('inv|' + m[1] + '|' + amount, '同じ請求書・同じ金額が別の月にもあります', r);
    add(['same', r.month, norm(r.kubun), norm(r.item), amount, norm(r.tax)].join('|'), '同じ月に同じ費目・同じ金額が2件以上あります', r);
  }
  const out: any[] = [], seen = new Set<string>();
  for (const [k, g] of groups) {
    if (g.rows.length < 2) continue;
    if (k.startsWith('inv|') && g.rows.every((r) => r.month === g.rows[0].month)) continue;
    const id = g.rows.map((r) => r.id).sort((a, b) => a - b).join(',');
    if (seen.has(id)) continue;
    seen.add(id);
    if (g.rows.every((r) => isLocked(r.month))) continue;
    out.push({ reason: g.reason, rows: [...g.rows].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.id - b.id))
      .map((r) => ({ month: r.month, kubun: r.kubun ?? '', item: r.item ?? '', amount: Number(r.amount), note: r.note ?? '', paid: isLocked(r.month) })) });
  }
  return out;
}

export function buildDashboard(data: Data, user: User, monthKey: string | null) {
  const thisMonth = data.thisMonth;
  let month = monthKey || addMonths(thisMonth, -1);
  if (month < START_MONTH) month = START_MONTH;
  const months = monthList(month, thisMonth);
  const cfg = allowedStores(user, [...data.stores].sort((a, b) => a.sort_order - b.sort_order));
  const paidAll = paidMap(data.payments);
  const sentLog = sentMap(data.logs);
  const sales = new Map<string, any>(data.sales.map((s) => [s.month + '|' + s.sales_key, s]));
  const kubun = new Set<string>(KUBUN_OPTIONS);
  const isHq = user.role === '本部' || user.role === 'マスター';
  const clients = new Set<string>();

  const stores = cfg.map((st) => {
    const rows = data.lines.filter((l) => l.store_key === st.store_key && !l.deleted_at)
      .sort((a, b) => (a.legacy_row ?? Infinity) - (b.legacy_row ?? Infinity) || a.id - b.id); // 写した行は元の順、あとから足した行は登録順
    const byMonth: Record<string, any[]> = {};
    for (const r of rows) { (byMonth[r.month] ||= []).push(r); if (r.kubun) kubun.add(r.kubun); }
    const register = (mk: string) => {
      if (!st.sales_name || mk < ROYALTY_ACTUAL_FROM || mk > thisMonth) return null;
      const v = Number(sales.get(mk + '|' + norm(st.sales_name))?.pay_total ?? 0);
      return v > 0 ? v : null;
    };
    const settleFor = (mk: string) => settle(byMonth[mk] || [], mk, termsAt(st, mk, data.terms), register(mk));
    const paidFor = (mk: string) => {
      const client = clientAt(st, mk, data.periods);
      const byClient = paidAll[norm(client || NO_CLIENT)] || {};
      const byStore = paidAll[norm(st.name)] || {};
      return byClient[mk] || byStore[mk];
    };
    const matrix: Record<string, any> = {};
    for (const mk of months) {
      const s = settleFor(mk), paid = paidFor(mk);
      matrix[mk] = {
        count: s.count, cost: s.varCost + s.royF, sales: s.sales,
        transfer: s.hasSales ? s.transfer : null, ns: s.hasSales ? s.ns : null,
        sent: !!sentLog[norm(st.name)]?.[mk], paid: !!paid?.done, paidTotal: paid?.total || 0,
      };
    }
    const chk = st.db_sheet ? missing(byMonth, month, st.required_items) : { missing: [], catWarn: ['DBシート未検出'] };
    const curRows = (byMonth[month] || []).map((r) => ({
      row: r.id, kubun: r.kubun ?? '', item: r.item ?? '', amount: Number(r.amount), tax: r.tax ?? '', note: r.note ?? '',
      editor: r.editor ?? '', at: r.entered_at ?? '', edited: r.edited_at ?? '', account: r.account ?? '', subAccount: r.sub_account ?? '',
      extRef: r.ext_ref ?? '',
    }));
    const { ...s } = settleFor(month);
    const sent = sentLog[norm(st.name)]?.[month] || null;
    const paid = paidFor(month);
    const sm = sales.get(month + '|' + norm(st.sales_name));
    const salesCheck = sm ? {
      source: Number(sm.pay_total), point: sm.point_total == null ? undefined : Number(sm.point_total),
      entered: s.sales, diff: s.sales - Number(sm.pay_total), salesName: st.sales_name,
    } : null;
    const issued: Record<string, boolean> = st.issued || {};
    const client = clientAt(st, month, data.periods);
    clients.add(norm(client));
    const cur = termsAt(st, month, data.terms);
    return {
      suspects: isHq ? dupSuspects(rows, (mk) => !!paidFor(mk)?.done) : [],
      name: st.name, client, rate: cur.rate_text ?? '',
      fixed: {
        rent: Number(cur.rent), ins: Number(cur.insurance), sss: Number(cur.accounting_fee), f4: Number(cur.fixed4), f5: Number(cur.fixed5),
        total: ['rent', 'insurance', 'accounting_fee', 'fixed4', 'fixed5'].reduce((a, k) => a + Number(cur[k] || 0), 0),
      },
      dbSheet: st.db_sheet ?? '', hasDb: !!st.db_sheet, matrix, issued,
      detail: {
        rows: curRows, sales: s.sales, cost: s.costTotal, count: curRows.length, settle: s,
        missing: chk.missing, catWarn: chk.catWarn, issuedThis: issued[month] === true || !!sent, sent,
        paid: paid || null, locked: !!paid?.done, salesCheck,
      },
    };
  });

  // 振込先口座は、本部以外には自分の担当店舗の委託先の分だけを返す
  const corps: Record<string, { account: string; note: string }> = {};
  for (const r of data.corpRows.slice(1)) {
    const key = norm(r[0]);
    if (r[0] && (isHq || clients.has(key))) corps[key] = { account: String(r[1] ?? '').trim(), note: String(r[2] ?? '').trim() };
  }

  const [y, m] = month.split('-').map(Number);
  return {
    user: { name: user.name, role: user.role }, month, monthLabel: `${y}年${m}月`, months, stores, corps,
    kubunOptions: [...kubun], taxOptions: TAX_OPTIONS, accountOptions: ACCOUNT_LIST,
  };
}

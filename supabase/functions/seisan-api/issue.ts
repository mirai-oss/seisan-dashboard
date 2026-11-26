// 精算書の発行とメール（今のGASの sd_issueAndSend / sd_setPaid と同じ文面と決まり）。通信はしない純粋な部分。
import { allowedStores, buildDashboard, norm, settle, termsAt, ROYALTY_ACTUAL_FROM, type Data, type User } from './dashboard.ts';

export const ATTACH_LIMIT = 24 * 1024 * 1024;
const monthDot = (m: string) => m.replace('-', '.');
const monthOnly = (m: string) => `${Number(m.slice(5, 7))}月`;
export const yen = (n: number) => '¥' + Math.round(Number(n) || 0).toLocaleString('en-US');

export const pdfName = (store: string, month: string, resend: boolean) => `精算書_${monthDot(month)}_${store}${resend ? '_再送信' : ''}.pdf`;

// PDFの係（GAS）へ渡す内容。権限の無い店舗は null
export function statementModel(data: Data & { settings?: Record<string, string> }, user: User, store: string, month: string) {
  const st = allowedStores(user, data.stores).find((s: any) => s.name === store);
  if (!st) return null;
  const rows = data.lines.filter((l) => l.store_key === st.store_key && l.month === month && !l.deleted_at)
    .sort((a, b) => (a.legacy_row ?? Infinity) - (b.legacy_row ?? Infinity) || a.id - b.id);
  const cur = termsAt(st, month, data.terms);
  const sale = data.sales.find((x) => x.month === month && x.sales_key === norm(st.sales_name));
  const register = st.sales_name && month >= ROYALTY_ACTUAL_FROM && month <= data.thisMonth && Number(sale?.pay_total ?? 0) > 0 ? Number(sale.pay_total) : null;
  const s: any = settle(rows, month, cur, register);
  const pick = (r: any) => ({ item: r.item ?? '', amount: Number(r.amount), tax: r.tax ?? '', note: r.note ?? '' });
  s.salesRows = rows.filter((r) => norm(r.kubun) === '売上').map(pick);
  s.varRows = rows.filter((r) => !['売上', '固定ロイヤリティ', '固定調整'].includes(norm(r.kubun))).map(pick);
  let period: any = null;
  for (const p of data.periods) if (p.store_key === st.store_key && p.from_month <= month && (!period || p.from_month > period.from_month)) period = p;
  const ciSrc = period ?? st;
  const fixed = { rent: Number(cur.rent), ins: Number(cur.insurance), sss: Number(cur.accounting_fee), f4: Number(cur.fixed4), f5: Number(cur.fixed5) };
  return {
    store: st.name, monthKey: month, stName: st.name,
    ci: { client: ciSrc.client ?? '', corp: ciSrc.corp ?? '', invoice: ciSrc.invoice_number ?? '', rep: ciSrc.representative ?? '' },
    ext: data.settings ?? {}, rate: cur.rate_text ?? '', fixed: { ...fixed, total: fixed.rent + fixed.ins + fixed.sss + fixed.f4 + fixed.f5 }, s,
  };
}

// 精算書と一緒に送る添付（過去の精算書PDFは除く・合計24MBまで）
export function pickAttachments(files: { name: string; size: number; path: string }[], pdfBytes: number) {
  let total = pdfBytes;
  const send: typeof files = [], names: string[] = [];
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    if (f.name.startsWith('精算書_')) continue;
    if (total + f.size > ATTACH_LIMIT) { names.push(`（容量超過のため未添付: ${f.name}）`); continue; }
    send.push(f); names.push(f.name); total += f.size;
  }
  return { send, names };
}

export function statementMail(mail: any, settings: Record<string, string>, month: string, resend: boolean, fileName: string, attachNames: string[]) {
  let subject = String(mail?.subject || '【重要】 〇月分業務委託料精算書のご送付').replace(/〇月/g, monthOnly(month));
  let body = String(mail?.body || '').replace(/〇月/g, monthOnly(month));
  if (resend) {
    subject = '【再送信】' + subject;
    body = '※本メールは、内容修正に伴う精算書の再送信です。お手数ですが最新版（添付）をご確認ください。\n\n' + body;
  }
  if (attachNames.length) body += '\n\n■添付書類\n・' + fileName + '（精算書）\n・' + attachNames.join('\n・');
  if (settings['ダッシュボードURL']) body += '\n\n──────────────────\n■ 精算ダッシュボード（過去分の精算書もこちらでご確認いただけます）\n' + settings['ダッシュボードURL'];
  return { to: String(mail?.to ?? '').trim(), cc: String(mail?.cc ?? '').trim(), subject, body, senderName: settings['メール送信者名'] || '株式会社N-Style' };
}

export function paidMail(store: any, settings: Record<string, string>, month: string, data: Data, user: User) {
  const to = String(store.mail?.to ?? '').trim();
  if (!to) return null;
  const sender = settings['メール送信者名'] || '株式会社N-Style';
  const view = buildDashboard(data, user, month).stores.find((s: any) => s.name === store.name);
  const amount = view?.detail.settle.hasSales ? '■振込金額（税込）：' + yen(view.detail.settle.transfer) + '\n' : '';
  let body = 'ご担当者様\n\nいつも大変お世話になっております。\n' + sender + 'です。\n\n' + monthOnly(month)
    + '分の業務委託料につきまして、お振込が完了いたしましたのでご連絡申し上げます。\n\n■対象店舗：' + store.name + '\n' + amount + '\nご査収のほど、よろしくお願い申し上げます。';
  if (settings['ダッシュボードURL']) body += '\n\n──────────────────\n■ 精算ダッシュボード（過去分の精算書もこちらでご確認いただけます）\n' + settings['ダッシュボードURL'];
  return { to, cc: String(store.mail?.cc ?? '').trim(), subject: '【お知らせ】' + monthOnly(month) + '分業務委託料 お振込完了のご連絡（' + store.name + '）', body, senderName: sender };
}

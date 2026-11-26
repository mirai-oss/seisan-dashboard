// 毎日の定期処理の判断と、未処理の通知文（今のGASの sd_autoPrepTick / sd_cashAutoTick / sd_remindTick と同じ決まり）
import { addMonths, buildDashboard, type Data } from './dashboard.ts';
import { yen } from './issue.ts';

export function jobsFor(todayJst: string) { // 'YYYY-MM-DD'
  const day = Number(todayJst.slice(8, 10)), prev = addMonths(todayJst.slice(0, 7), -1);
  return { prevMonth: prev, prepare: day === 1, cash: day === 5, remind: day === 17 || day === 20 || day > 20, day };
}

export function remindMessage(data: Data, todayJst: string) {
  const { day, prevMonth } = jobsFor(todayJst);
  const view = buildDashboard(data, { name: '自動', role: 'マスター' }, prevMonth);
  const lines: string[] = [];
  let need = 0;
  for (const st of view.stores as any[]) {
    const d = st.detail;
    if (!st.hasDb) { lines.push('■ ' + st.name + '：⚠ DBシート未検出'); need++; continue; }
    const isPaid = !!d.paid?.done;
    const status = isPaid ? '💰振込済み' : d.issuedThis ? '✅発行済み（振込待ち）' : d.count > 0 ? '🟡入力中 ' + d.count + '件' : '❌未入力';
    const warns = [...d.catWarn, ...d.missing];
    if (isPaid && !warns.length) continue;
    let line = '■ ' + st.name + '：' + status;
    if (d.settle.hasSales) line += '　振込金額(税込) ' + yen(d.settle.transfer);
    if (warns.length) line += '\n　└ 入力漏れの疑い: ' + warns.join('、');
    if (!isPaid) need++;
    lines.push(line);
  }
  if (!need) return null;
  const label = `${Number(prevMonth.slice(0, 4))}年${Number(prevMonth.slice(5, 7))}月`;
  const head = day > 20 ? '🚨 ' + label + '分の振込期限（20日）を過ぎています！至急ご対応ください。'
    : day === 20 ? '⏰ 本日が' + label + '分の振込期限（20日）です。' : '📅 ' + label + '分の振込期限（20日）まであと3日です。';
  return { text: '💰 業務委託料 振込リマインド（対応必要: ' + need + '店舗）\n' + head + '\n\n' + lines.join('\n\n'), key: 'seisan_remind:' + prevMonth + ':' + day };
}

// 精算ダッシュボードのログインと利用申請（GASの sd_login などと同じ決まり）。
// データベースは Store という口を通してだけ触る（手元のテストでは偽の口を使う）。パスワードとトークンは記録しない。

export type Account = { login_id: string; pw_hash: string; name: string; role: string; stores_raw: string; enabled: boolean; email: string };
export type AccessRequest = { id: string; at?: string; at_text?: string; email: string; name: string; company: string; status: string; handled_by?: string; handled_at?: string; created_id?: string; note?: string; base_id?: string };
export type User = { id: string; name: string; role: string; storesRaw: string; email: string };

export interface Store {
  mode(): Promise<string>;                               // 'copy'（切り替え前） か 'live'
  accounts(): Promise<Account[]>;
  insertAccount(a: Account): Promise<void>;
  updateAccount(id: string, patch: Partial<Account>): Promise<void>;
  createSession(tokenHash: string, loginId: string, expiresAt: string): Promise<void>;
  deleteSessions(loginId: string): Promise<void>;
  revokeSnapshots(): Promise<void>;
  failState(key: string): Promise<number>;               // 直近15分の失敗回数
  addFail(key: string): Promise<void>;
  clearFail(key: string): Promise<void>;
  log(event: string, who: string, result: string): Promise<void>;
  putResetToken(tokenHash: string, loginId: string, expiresAt: string): Promise<void>; // 同じ人の古いリンクは消す
  takeResetToken(tokenHash: string): Promise<string | null>;                          // 1回だけ使える
  requests(): Promise<AccessRequest[]>;
  insertRequest(r: AccessRequest): Promise<void>;
  updateRequest(id: string, patch: Partial<AccessRequest>): Promise<void>;
}

export type Deps = {
  store: Store;
  fetch: typeof fetch;
  googleClientId: string;
  portal: { url: string; key: string };
  sendMail?: (to: string, subject: string, body: string) => Promise<void>;
  notify?: (text: string, dedupeKey: string) => Promise<void>;
};

export class AppError extends Error {}
const fail = (m: string): never => { throw new AppError(m); };

const SESSION_HOURS = 336;
const RESET_URL = 'https://mirai-oss.github.io/seisan-dashboard/';
const ITER = 100_000;
const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b as ArrayBuffer)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const sha256hex = async (t: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(t)));
const random = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));
const norm = (s: unknown) => String(s ?? '').replace(/[\s　]+/g, '');
const lower = (s: unknown) => String(s ?? '').trim().toLowerCase();

async function pbkdf2(pw: string, salt: string, iter: number) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: iter }, key, 256));
}
export async function hashPassword(pw: string) {
  const salt = random(16);
  return `pbkdf2$${ITER}$${salt}$${await pbkdf2(pw, salt, ITER)}`;
}
const same = (a: string, b: string) => { // 一致の判定にかかる時間を、内容で変えない
  let d = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
  return d === 0;
};
export async function verifyPassword(stored: string, pw: string) {
  const p = String(stored || '').split('$');
  if (p[0] === 'pbkdf2' && p.length === 4) return same(await pbkdf2(pw, p[2], Number(p[1])), p[3]);
  if (p[0] === 'sha256' && p.length === 3) return same(await sha256hex(p[1] + '|' + pw), p[2]); // GASから写した形
  return false; // 空（Googleや再設定でだけ入るアカウント）や、それ以外の形では入れない
}

async function startSession(d: Deps, a: Account) {
  const token = crypto.randomUUID();
  await d.store.createSession(await sha256hex(token), a.login_id, new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString());
  return { token, name: a.name, role: a.role };
}
const byId = (list: Account[], id: unknown) => list.find((a) => a.login_id === String(id ?? '').trim());
const byEmail = (list: Account[], email: unknown) => (lower(email) ? list.find((a) => lower(a.email) === lower(email)) : undefined);

export async function login(d: Deps, id: unknown, pw: unknown) {
  const key = await sha256hex(lower(id));
  if ((await d.store.failState(key)) >= 5) {
    await d.store.log('ログイン', String(id), '制限中');
    fail('ログインに続けて失敗したため、しばらく時間をおいてからお試しください（パスワードを忘れた場合は「パスワードを忘れた方」から再設定できます）');
  }
  const a = byId(await d.store.accounts(), id);
  if (!a || !a.enabled || !(await verifyPassword(a.pw_hash, String(pw ?? '')))) {
    await d.store.addFail(key);
    await d.store.log('ログイン', String(id), '失敗');
    fail('IDまたはパスワードが違います');
  }
  await d.store.clearFail(key);
  if (a!.pw_hash.startsWith('sha256$')) await d.store.updateAccount(a!.login_id, { pw_hash: await hashPassword(String(pw)) }); // より強い形に置き換える
  await d.store.log('ログイン', String(id), '成功');
  return startSession(d, a!);
}

export async function googleVerify(d: Deps, idToken: unknown) {
  if (!idToken) fail('Googleのログイン情報がありません');
  const res = await d.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(String(idToken)));
  if (res.status !== 200) fail('Googleの認証が無効です。もう一度ログインしてください');
  const j: any = await res.json().catch(() => ({}));
  if (String(j.aud || '') !== d.googleClientId) fail('このGoogleログインは、この画面用ではありません');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(String(j.iss || ''))) fail('Googleの認証元が正しくありません');
  if (!(Number(j.exp) * 1000 > Date.now())) fail('Googleのログインの有効期限が切れています。もう一度ログインしてください');
  if (String(j.email_verified) !== 'true') fail('Googleアカウントのメールが確認されていません');
  const email = lower(j.email);
  if (!email) fail('Googleアカウントのメールアドレスを取得できませんでした');
  return email;
}

export async function googleLogin(d: Deps, idToken: unknown) {
  const email = await googleVerify(d, idToken);
  const a = byEmail(await d.store.accounts(), email);
  if (!a) { await d.store.log('Googleログイン', email, '失敗（未登録）'); fail('このGoogleアカウント（' + email + '）は登録されていません。本部に、メールアドレスの登録を依頼してください'); }
  if (!a!.enabled) { await d.store.log('Googleログイン', email, '失敗（無効）'); fail('このアカウントは無効化されています'); }
  await d.store.log('Googleログイン', email, '成功');
  return startSession(d, a!);
}

export async function portalLogin(d: Deps, portalToken: unknown) {
  if (!portalToken) fail('統合アカウントのトークンがありません');
  const res = await d.fetch(d.portal.url + '/auth/v1/user', { headers: { apikey: d.portal.key, Authorization: 'Bearer ' + String(portalToken) } });
  if (res.status !== 200) fail('統合アカウントの認証が無効です。もう一度ログインしてください');
  const email = lower((await res.json().catch(() => ({} as any))).email);
  if (!email) fail('統合アカウントのメールアドレスを取得できませんでした');
  const a = byEmail(await d.store.accounts(), email);
  if (!a) fail('このメール（' + email + '）に対応する精算ダッシュボードのアカウントがありません。設定タブの「メール」欄に登録してください');
  if (!a!.enabled) fail('このアカウントは無効化されています');
  if (a!.role === '委託先') fail('業務委託先アカウントは統合ログインの対象外です。従来のIDとパスワードでログインしてください');
  return startSession(d, a!);
}

const requireLive = async (d: Deps) => { if ((await d.store.mode()) !== 'live') fail('切り替え前のため、ここでは変更できません。いつもの画面で行ってください'); };

export async function requestPasswordReset(d: Deps, idOrEmail: unknown) {
  await requireLive(d);
  const generic = { ok: true, message: '登録されているメールアドレス宛に、パスワード再設定のメールを送りました（届かない場合は、登録メールが無い可能性があります。本部にご連絡ください）' };
  if (!d.sendMail) fail('メールの送信は準備中です。本部にご連絡ください');
  const list = await d.store.accounts();
  const a = byId(list, idOrEmail) || byEmail(list, idOrEmail);
  if (!a || !a.enabled || !a.email) { await d.store.log('再設定の依頼', String(idOrEmail), '対象なし'); return generic; }
  const key = 'reset|' + (await sha256hex(a.login_id));
  if ((await d.store.failState(key)) >= 3) { await d.store.log('再設定の依頼', a.login_id, '回数制限'); return generic; }
  await d.store.addFail(key);
  const token = random(32);
  await d.store.putResetToken(await sha256hex(token), a.login_id, new Date(Date.now() + 30 * 60_000).toISOString());
  await d.sendMail!(a.email, '【N-Style】精算ダッシュボード パスワード再設定のご案内',
    (a.name || a.login_id) + ' 様\n\n精算ダッシュボードのパスワード再設定の依頼を受け付けました。\n下のリンクを開いて、新しいパスワードを決めてください（30分間有効・1回だけ使えます）。\n\n'
    + RESET_URL + '?reset=' + token + '\n\n心当たりがない場合は、このメールは無視してください（パスワードは変わりません）。\n\nN-Style 精算ダッシュボード');
  await d.store.log('再設定の依頼', a.login_id, 'メール送信');
  return generic;
}

export async function resetPassword(d: Deps, token: unknown, newPw: unknown) {
  await requireLive(d);
  const t = String(token ?? '').trim(), pw = String(newPw ?? '');
  if (!t) fail('再設定のリンクが正しくありません');
  if (pw.length < 8) fail('パスワードは8文字以上にしてください');
  const id = await d.store.takeResetToken(await sha256hex(t));
  if (!id) { await d.store.log('再設定の実行', '（不明）', '失敗（期限切れ・使用済み）'); fail('再設定のリンクの有効期限が切れています。もう一度「パスワードを忘れた方」から依頼してください'); }
  const a = byId(await d.store.accounts(), id);
  if (!a || !a.enabled) fail('このアカウントは使えません');
  await d.store.updateAccount(id!, { pw_hash: await hashPassword(pw) });
  await d.store.deleteSessions(id!); // 変更前のログインは切る
  await d.store.log('再設定の実行', id!, '成功');
  return { ok: true };
}

async function companies(list: Account[]) {
  const base = list.filter((a) => a.role === '委託先' && a.enabled && !/-\d{2}$/.test(a.login_id));
  return Promise.all(base.map(async (a) => ({ key: (await sha256hex('company|' + a.login_id)).slice(0, 12), id: a.login_id, name: a.name || a.login_id })));
}
export async function requestAccessOptions(d: Deps, idToken: unknown) {
  await googleVerify(d, idToken);
  return (await companies(await d.store.accounts())).map((o) => ({ key: o.key, name: o.name }));
}
export async function requestAccess(d: Deps, idToken: unknown, name: unknown, companyKey: unknown) {
  await requireLive(d);
  const email = await googleVerify(d, idToken);
  const person = String(name ?? '').trim();
  if (!person || person.length > 40) fail('氏名を入力してください（40文字以内）');
  const list = await d.store.accounts();
  const opt = (await companies(list)).find((o) => o.key === String(companyKey ?? ''));
  if (!opt) fail('会社名を、一覧から選んでください');
  if (byEmail(list, email)) fail('このGoogleアカウントは、すでに登録されています。「Googleでログイン」から入ってください');
  const key = 'accreq|' + (await sha256hex(email));
  if ((await d.store.failState(key)) >= 3) { await d.store.log('利用申請', email, '回数制限'); fail('申請の回数が多すぎます。しばらくしてからお試しください'); }
  if ((await d.store.requests()).some((r) => r.email === email && r.status === '申請中')) fail('すでに申請中です。本部の承認をお待ちください');
  await d.store.addFail(key);
  const id = 'REQ-' + new Date(Date.now() + 9 * 3600_000).toISOString().replace(/\D/g, '').slice(0, 14) + '-' + random(2);
  await d.store.insertRequest({ id, email, name: person, company: opt!.name, status: '申請中', base_id: opt!.id });
  await d.store.log('利用申請', email, '受付');
  await d.notify?.('🙋【精算ダッシュボード アカウント申請】' + person + ' 様（' + opt!.name + '）から利用申請がありました。\n精算ダッシュボードの「設定」タブ →「アカウント申請」で確認してください。', id).catch(() => {});
  await d.sendMail?.(email, '【N-Style】精算ダッシュボード 利用申請を受け付けました', person + ' 様\n\n精算ダッシュボードの利用申請を受け付けました。本部が内容を確認します。').catch(() => {});
  return { ok: true, message: '申請を受け付けました。本部が確認します。承認されたら、メールでお知らせします。' };
}

const requireHq = (u: User) => { if (u.role !== '本部' && u.role !== 'マスター') fail('この操作は本部アカウントのみ実行できます'); };

export async function listAccessRequests(d: Deps, user: User) {
  requireHq(user);
  return (await d.store.requests()).sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))).slice(0, 100)
    .map((r) => ({ id: r.id, at: r.at_text || String(r.at ?? '').slice(0, 16).replace('T', ' '), email: r.email, name: r.name, company: r.company, status: r.status, by: r.handled_by, doneAt: r.handled_at, createdId: r.created_id, note: r.note, baseId: r.base_id }));
}
async function pending(d: Deps, reqId: unknown) {
  const r = (await d.store.requests()).find((x) => x.id === String(reqId ?? ''));
  if (!r) fail('申請が見つかりません');
  if (r!.status !== '申請中') fail('この申請は、すでに処理済みです（' + r!.status + '）');
  return r!;
}
export async function approveAccess(d: Deps, user: User, reqId: unknown, baseId: unknown) {
  await requireLive(d); requireHq(user);
  const r = await pending(d, reqId);
  if (lower(user.email) === lower(r.email) && lower(user.email)) fail('自分の申請は、自分で承認できません');
  const list = await d.store.accounts();
  if (byEmail(list, r.email)) fail('このメールは、すでにアカウントに登録されています');
  const base = byId(list, baseId);
  if (!base || base.role !== '委託先') fail('どの委託先として登録するか（既存の委託先アカウント）を選んでください');
  const used = new Set(list.map((a) => a.login_id.toLowerCase()));
  let newId = '';
  for (let n = 2; n < 100 && !newId; n++) { const c = base!.login_id + '-' + String(n).padStart(2, '0'); if (!used.has(c.toLowerCase())) newId = c; }
  if (!newId) fail('ログインIDを作れませんでした');
  await d.store.insertAccount({ login_id: newId, pw_hash: '', name: r.name + '（' + base!.name + '）', role: '委託先', stores_raw: base!.stores_raw, enabled: true, email: r.email });
  await d.store.updateRequest(r.id, { status: '承認', handled_by: user.id || user.name, handled_at: new Date().toISOString(), created_id: newId, note: '委託先: ' + base!.login_id + ' から担当店舗をコピー' });
  await d.store.log('利用申請の承認', r.email, '承認（' + newId + '）');
  await d.sendMail?.(r.email, '【N-Style】精算ダッシュボード 利用申請が承認されました', r.name + ' 様\n\n利用申請が承認されました。下のページを開いて「Googleでログイン」から入ってください。\n' + RESET_URL).catch(() => {});
  return { ok: true, id: newId };
}
export async function rejectAccess(d: Deps, user: User, reqId: unknown, reason: unknown) {
  await requireLive(d); requireHq(user);
  const r = await pending(d, reqId);
  await d.store.updateRequest(r.id, { status: '却下', handled_by: user.id || user.name, handled_at: new Date().toISOString(), note: String(reason ?? '').trim().slice(0, 100) });
  await d.store.log('利用申請の却下', r.email, '却下');
  await d.sendMail?.(r.email, '【N-Style】精算ダッシュボード 利用申請について', r.name + ' 様\n\n今回の利用申請は、承認されませんでした。心当たりがない場合や、ご不明な点は本部にご連絡ください。').catch(() => {});
  return { ok: true };
}

const normRole = (raw: unknown) => { const n = norm(raw); return n === 'マスター' || n === 'ﾏｽﾀｰ' ? 'マスター' : n === '本部' ? '本部' : '委託先'; };

export async function saveAccount(d: Deps, user: User, acc: any) {
  await requireLive(d); requireHq(user);
  const id = String(acc?.id ?? '').trim();
  if (!id) fail('ログインIDを入力してください');
  const list = await d.store.accounts();
  const existing = byId(list, id), role = normRole(acc.role);
  if ((role === 'マスター' || existing?.role === 'マスター') && user.role !== 'マスター') fail('この操作はマスターアカウントのみ実行できます');
  const email = lower(acc.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('メールアドレスの形が正しくありません');
  const dup = byEmail(list, email);
  if (dup && dup.login_id.toLowerCase() !== id.toLowerCase()) fail('このメールは、別のアカウントで使われています');
  const pw = String(acc.pw ?? '');
  const row: Account = {
    login_id: id, pw_hash: pw ? await hashPassword(pw) : existing?.pw_hash ?? '', name: String(acc.name || id).trim(), role,
    stores_raw: String(acc.stores ?? '').trim() || (role !== '委託先' ? '全店' : ''), enabled: acc.enabled !== false, email,
  };
  // 担当店舗が空の委託先は全店が見えてしまうため、保存させない
  if (role === '委託先' && !row.stores_raw) fail('委託先アカウントは、担当店舗を入力してください');
  if (existing) await d.store.updateAccount(id, row); else await d.store.insertAccount(row);
  if (existing && (!row.enabled || pw || existing.role !== role || existing.stores_raw !== row.stores_raw)) await d.store.deleteSessions(id);
  await d.store.revokeSnapshots();
  await d.store.log('アカウント保存', id, '成功（' + (user.id || user.name) + '）');
  return { ok: true, id, updated: !!existing };
}

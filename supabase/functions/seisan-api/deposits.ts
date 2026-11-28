// 委託先向け「入金」タブの読み取り（sd_getDeposits）。DB の判定は settle_client_deposits（サービスロール専用）が全て行う。
// ここは ①入力の検査（引数は [トークン, 月] だけ。それ以外は無視でなく拒否） ②DB の結果を許可リストの項目だけに絞って返す、だけ。
// 店舗 ID・委託先 ID を受け取る口は無い。トークン・金額はログに出さない。
export type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export type Reply = { status: number; body: unknown };

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ok = (result: unknown): Reply => ({ status: 200, body: { ok: true, result } });
const err = (error: string, status = 200): Reply => ({ status, body: { ok: false, error } });

export const DEPOSIT_ERRORS = {
  denied: 'DEPOSIT_DENIED',   // スイッチOFF・期間外・共有アカウント・古いパスワード形式など（理由は区別しない）
  relogin: 'DEPOSIT_RELOGIN', // ログインから12時間を過ぎた（ほかの機能は14日のまま。ここだけ短い）
  rate: 'DEPOSIT_RATE',       // 1時間に60回まで
} as const;

export async function getDeposits(body: Record<string, unknown>, args: unknown[], rpc: Rpc): Promise<Reply> {
  // 未知のフィールドは拒否（store_id・contractor_id などを付けても通らない）
  if (Object.keys(body ?? {}).some((k) => k !== 'fn' && k !== 'args')) return err('リクエストの形式が不正です', 400);
  if (args.length !== 2 || typeof args[0] !== 'string' || typeof args[1] !== 'string') return err('リクエストの形式が不正です', 400);
  const [token, month] = args as [string, string];
  if (!YM.test(month)) return err('対象月の形式が不正です');

  const r: any = await rpc('settle_client_deposits', { p_token: token, p_month: month });
  switch (r?.status) {
    case 'auth': return err('AUTH', 401);
    case 'denied': return err(DEPOSIT_ERRORS.denied);
    case 'relogin': return err(DEPOSIT_ERRORS.relogin);
    case 'rate': return err(DEPOSIT_ERRORS.rate, 429);
    case 'ok': break;
    default: throw new Error('deposit status'); // 想定外は、中身を返さず汎用のエラーにする
  }
  // 許可リスト：DB が余計な項目を返しても、ここで落とす
  const text = (v: unknown) => String(v ?? '');
  const rows = (Array.isArray(r.rows) ? r.rows : []).filter((x: any) => DATE.test(text(x?.date))).map((x: any) => ({
    store: text(x.store), date: text(x.date), amount: Number(x.amount) || 0, count: Number(x.count) || 0,
    status: x.status === 'checking' ? 'checking' : 'deposited',
  }));
  return ok({
    month: YM.test(text(r.month)) ? r.month : month,
    stores: (Array.isArray(r.stores) ? r.stores : []).map(text),
    months: (Array.isArray(r.months) ? r.months : []).map(text).filter((m: string) => YM.test(m)),
    rows,
    asOf: r.asOf ? text(r.asOf) : null,
  });
}

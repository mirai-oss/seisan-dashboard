// 精算ダッシュボードの新しい窓口（移行中）。今のGASと同じ {fn, args} の形で受け、{ok, result} を返す。
// 認証: ログイン用トークン（新しい窓口のログイン、または今のダッシュボードのログイン）。
// 書き込みは、切り替え（settle_config の mode='live'）までデータベース側と auth.ts の両方で断る。
// トークン・パスワード・中身はログに出さない。
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildDashboard } from "./dashboard.ts";
import * as auth from "./auth.ts";
import { buildSettings } from "./settings.ts";
import { supaStore } from "./store.ts";

const ORIGIN = "https://mirai-oss.github.io";
const GOOGLE_CLIENT_ID = "776072969993-jn4ujnt4srevj76krlmmasvl6bqe4rfo.apps.googleusercontent.com"; // 公開してよい値
const cors = { "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Headers": "content-type, apikey, authorization" };
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const URL_ = Deno.env.get("SUPABASE_URL")!;
const db = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const jst = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString();

async function notifySlack(text: string, dedupeKey: string) {
  const { data } = await db.from("app_secrets").select("value").eq("key", "notify_slack_secret").maybeSingle();
  if (!data?.value) return;
  await fetch(URL_ + "/functions/v1/notify-slack", {
    method: "POST", headers: { "Content-Type": "application/json", "x-notify-secret": data.value },
    body: JSON.stringify({ action: "send", channel_key: "hq.keiri_kanshi", text, event: "seisan", source: "seisan-api", dedupe_key: dedupeKey, username: "N-Style 通知Bot" }),
  });
}

const deps: auth.Deps = {
  store: supaStore(db), fetch, googleClientId: GOOGLE_CLIENT_ID,
  portal: { url: URL_, key: Deno.env.get("SUPABASE_ANON_KEY")! },
  notify: notifySlack, // メール送信(sendMail)は移行の段階3-5で用意する
};

// ログインしていなくても呼べるもの
const PUBLIC: Record<string, (a: any[]) => Promise<unknown>> = {
  sd_login: (a) => auth.login(deps, a[0], a[1]),
  sd_googleLogin: (a) => auth.googleLogin(deps, a[0]),
  sd_supaLogin: (a) => auth.portalLogin(deps, a[0]),
  sd_requestPasswordReset: (a) => auth.requestPasswordReset(deps, a[0]),
  sd_resetPassword: (a) => auth.resetPassword(deps, a[0], a[1]),
  sd_requestAccessOptions: (a) => auth.requestAccessOptions(deps, a[0]),
  sd_requestAccess: (a) => auth.requestAccess(deps, a[0], a[1], a[2]),
};

class DbError extends auth.AppError {}
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(name, args);
  if (!error) return data;
  // 関数が自分で出した案内（raise exception）だけを画面に返す
  if (error.code === "P0001") throw new DbError(error.message);
  console.error("rpc error", name, error.code);
  throw new Error("database");
}

// ログインが必要なもの（a は、トークンより後ろの引数）
const AUTHED: Record<string, (u: auth.User, a: any[]) => Promise<unknown>> = {
  sd_addRows: (u, a) => rpc("settle_add_rows", { actor: u, p: a[0] }),
  sd_updateRow: (u, a) => rpc("settle_update_row", { actor: u, p: a[0] }),
  sd_deleteRow: (u, a) => rpc("settle_delete_row", { actor: u, p: a[0] }),
  sd_bulkAdd: (u, a) => rpc("settle_bulk_add", { actor: u, p: a[0] }),
  sd_setPaid: async (u, a) => { // a = [委託先, 月, 振込済みか, メールも送るか, 金額]
    const r: any = await rpc("settle_set_paid", { actor: u, p_client: a[0], p_month: a[1], p_done: !!a[2], p_amount: a[4] ?? null });
    return { ...r, mailed: false, mailedStores: [] };
  },
  sd_listAccessRequests: (u) => auth.listAccessRequests(deps, u),
  sd_approveAccess: (u, a) => auth.approveAccess(deps, u, a[0], a[1]),
  sd_rejectAccess: (u, a) => auth.rejectAccess(deps, u, a[0], a[1]),
  sd_saveAccount: (u, a) => auth.saveAccount(deps, u, a[0]),
  sd_saveTerms: (u, a) => rpc("settle_save_terms", { actor: u, p: a[0] }),
  sd_deleteTerms: (u, a) => rpc("settle_delete_terms", { actor: u, p: a[0] }),
  sd_saveRecurring: (u, a) => rpc("settle_save_recurring", { actor: u, p: a[0] }),
  sd_saveMail: (u, a) => rpc("settle_save_mail", { actor: u, p: a[0] }),
  sd_saveCorp: (u, a) => rpc("settle_save_corp", { actor: u, p: a[0] }),
  sd_saveOpsSettings: (u, a) => rpc("settle_save_ops", { actor: u, p: a[0] }),
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POSTのみ対応" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "リクエストの解析に失敗しました" }, 400); }
  const fn = String(body?.fn ?? ""), args: any[] = Array.isArray(body?.args) ? body.args : [];
  const t0 = Date.now();
  try {
    if (Object.hasOwn(PUBLIC, fn)) return json({ ok: true, result: await PUBLIC[fn](args) });
    const READS = ["sd_getDashboard", "sd_getSettings", "sd_getOpsSettings"];
    if (!READS.includes(fn) && !Object.hasOwn(AUTHED, fn)) return json({ ok: false, error: "この機能は、移行の次の段階で使えるようになります" });
    const [token, ...rest] = args;
    if (typeof token !== "string" || token.length < 32) return json({ ok: false, error: "AUTH" }, 401);

    if (fn === "sd_getDashboard") {
      const month = rest[0] ?? null;
      if (month != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month))) return json({ ok: false, error: "対象月の形式が不正です" });
      const data: any = await rpc("settle_read", { p_token: token });
      if (!data) return json({ ok: false, error: "AUTH" }, 401);
      const readMs = Date.now() - t0;
      const result: any = buildDashboard({ ...data.data, thisMonth: jst(new Date()).slice(0, 7) }, data.user, month);
      result.ver = "db-test";
      result.sheetUrl = "";
      result.updatedAt = jst(new Date(data.importedAt)).slice(0, 16).replace("T", " ");
      result._ms = { read: readMs, total: Date.now() - t0 };
      return json({ ok: true, result });
    }

    if (fn === "sd_getSettings" || fn === "sd_getOpsSettings") {
      const d: any = await rpc("settle_settings", { p_token: token });
      if (!d) return json({ ok: false, error: "AUTH" }, 401);
      if (d.forbidden) return json({ ok: false, error: "この操作は本部アカウントのみ実行できます" });
      return json({ ok: true, result: fn === "sd_getOpsSettings" ? { ok: true, ...d.ops } : buildSettings(d, jst(new Date()).slice(0, 7)) });
    }

    const user: any = await rpc("settle_whoami", { p_token: token });
    if (!user) return json({ ok: false, error: "AUTH" }, 401);
    return json({ ok: true, result: await AUTHED[fn](user, rest) });
  } catch (e) {
    if (e instanceof auth.AppError) return json({ ok: false, error: e.message });
    console.error("seisan-api error", fn, (e as Error)?.name);
    return json({ ok: false, error: "処理に失敗しました。少し時間をおいて、もう一度お試しください" });
  }
});

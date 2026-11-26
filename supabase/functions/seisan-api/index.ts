// 精算ダッシュボードの新しい窓口（移行 段階2: 画面データの読み取りだけ）。
// 認証: 今のダッシュボードのログイン用トークン。確認と読み取りは settle_read（service_role だけが呼べる）で行う。
// 見える店舗の絞り込みは dashboard.ts（権限と担当店舗）。トークンや中身はログに出さない。
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildDashboard } from "./dashboard.ts";

const ORIGIN = "https://mirai-oss.github.io";
const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const jst = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString();

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POSTのみ対応" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "リクエストの解析に失敗しました" }, 400); }
  if (body?.fn !== "sd_getDashboard") return json({ ok: false, error: "この窓口は、画面の表示だけに対応しています" }, 400);
  const [token, month] = Array.isArray(body.args) ? body.args : [];
  if (typeof token !== "string" || token.length < 32) return json({ ok: false, error: "AUTH" }, 401);
  if (month != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month))) return json({ ok: false, error: "対象月の形式が不正です" }, 400);

  const t0 = Date.now();
  const { data, error } = await db.rpc("settle_read", { p_token: token });
  if (error) return json({ ok: false, error: "読み取りに失敗しました" }, 500);
  if (!data) return json({ ok: false, error: "AUTH" }, 401);
  const readMs = Date.now() - t0;

  const result: any = buildDashboard({ ...data.data, thisMonth: jst(new Date()).slice(0, 7) }, data.user, month ?? null);
  result.ver = "db-test";
  result.sheetUrl = "";
  result.updatedAt = jst(new Date(data.importedAt)).slice(0, 16).replace("T", " ");
  result._ms = { read: readMs, total: Date.now() - t0 };
  return json({ ok: true, result });
});

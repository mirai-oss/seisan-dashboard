// sd_getDeposits（入金タブ）の検査。本番には接続しない。  deno test --allow-all tests/deposits_test.ts
// ①単体: deposits.ts を、DB を模した関数（モック）で。②結合: 本物の index.ts を別プロセスで起動し、偽の PostgREST（RPC 受け口）につないで、HTTP で叩く。
import { DEPOSIT_ERRORS, getDeposits } from "../supabase/functions/seisan-api/deposits.ts";

let n = 0;
const eq = (name: string, a: unknown, b: unknown) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`NG: ${name}\n  実際: ${JSON.stringify(a)}\n  期待: ${JSON.stringify(b)}`); };
const yes = (name: string, c: boolean, x = "") => { n++; if (!c) throw new Error(`NG: ${name} ${x}`); };
const TOKEN = "t".repeat(40);
const GOOD = { status: "ok", month: "2026-10", stores: ["A店", "B店"], months: ["2026-10", "2026-09"], asOf: "2026-10-04T03:00:00+00:00",
  rows: [{ store: "A店", date: "2026-10-03", amount: 3000, count: 2, status: "checking" }, { store: "B店", date: "2026-10-04", amount: 5000, count: 1, status: "deposited" }] };
const calls: any[] = [];
const mk = (ret: unknown) => async (name: string, a: Record<string, unknown>) => { calls.push([name, a]); return ret; };

Deno.test("単体: deposits.ts", async () => {
  // 正常
  let r = await getDeposits({ fn: "sd_getDeposits", args: [TOKEN, "2026-10"] }, [TOKEN, "2026-10"], mk(GOOD));
  eq("正常 200", r.status, 200); eq("正常の中身", (r.body as any).result, { month: "2026-10", stores: ["A店", "B店"], months: ["2026-10", "2026-09"], rows: GOOD.rows, asOf: GOOD.asOf });
  eq("DB へ渡すのは p_token と p_month だけ", calls[0], ["settle_client_deposits", { p_token: TOKEN, p_month: "2026-10" }]);
  // DB が余計な項目を返しても、出さない（許可リスト）
  const dirty = { ...GOOD, secret: "x", rows: [{ ...GOOD.rows[0], memo: "SECRET摘要", store_id: "uuid", entries: [1] }] };
  r = await getDeposits({ fn: "f", args: [] }, [TOKEN, "2026-10"], mk(dirty));
  const t = JSON.stringify(r.body);
  yes("余計な項目（摘要・ID・entries・secret）は落とす", !/SECRET|store_id|entries|secret|uuid/.test(t), t);
  eq("行のキーは 5 つだけ", Object.keys((r.body as any).result.rows[0]).sort(), ["amount", "count", "date", "status", "store"]);
  eq("結果のキーは 5 つだけ", Object.keys((r.body as any).result).sort(), ["asOf", "months", "month", "rows", "stores"].sort());
  // 入力の拒否
  for (const [name, body, args] of [
    ["未知のフィールド（store_id）", { fn: "f", args: [TOKEN, "2026-10"], store_id: "x" }, [TOKEN, "2026-10"]],
    ["未知のフィールド（contractor_id）", { fn: "f", args: [TOKEN, "2026-10"], contractor_id: "x" }, [TOKEN, "2026-10"]],
    ["引数が 3 つ（店舗を足す）", { fn: "f", args: [] }, [TOKEN, "2026-10", "店舗ID"]],
    ["引数が 1 つ（月なし）", { fn: "f", args: [] }, [TOKEN]],
    ["月が文字列でない", { fn: "f", args: [] }, [TOKEN, 202610]],
    ["月が null", { fn: "f", args: [] }, [TOKEN, null]],
  ] as const) {
    const c0 = calls.length; r = await getDeposits(body as any, args as any, mk(GOOD));
    yes(`拒否: ${name}`, r.status === 400 && (r.body as any).ok === false && calls.length === c0);
  }
  for (const m of ["2026-13", "2026-1", "2026-10-01", "2026-10'; drop table x;--", "", "２０２６-１０"]) {
    const c0 = calls.length; r = await getDeposits({ fn: "f", args: [] }, [TOKEN, m], mk(GOOD));
    yes(`拒否: 月の形式 ${JSON.stringify(m)}（DB を呼ばない）`, (r.body as any).ok === false && calls.length === c0);
  }
  // 状態の対応
  r = await getDeposits({}, [TOKEN, "2026-10"], mk({ status: "auth" })); eq("auth → 401 AUTH", [r.status, (r.body as any).error], [401, "AUTH"]);
  r = await getDeposits({}, [TOKEN, "2026-10"], mk({ status: "denied" })); eq("denied → 200 DEPOSIT_DENIED（理由は返さない）", [r.status, r.body], [200, { ok: false, error: DEPOSIT_ERRORS.denied }]);
  r = await getDeposits({}, [TOKEN, "2026-10"], mk({ status: "relogin" })); eq("relogin", [r.status, (r.body as any).error], [200, DEPOSIT_ERRORS.relogin]);
  r = await getDeposits({}, [TOKEN, "2026-10"], mk({ status: "rate" })); eq("rate → 429", [r.status, (r.body as any).error], [429, DEPOSIT_ERRORS.rate]);
  yes("エラーコードに 'AUTH' を含まない（含むと既存画面が強制ログアウトする）", Object.values(DEPOSIT_ERRORS).every((e) => !e.includes("AUTH")));
  for (const bad of [null, {}, { status: "weird" }, { status: "ok", rows: "x" }]) {
    let thrown = false, body: any = null;
    try { body = (await getDeposits({}, [TOKEN, "2026-10"], mk(bad))).body; } catch { thrown = true; }
    yes(`想定外の DB 結果 ${JSON.stringify(bad)} → 中身を返さない`, thrown || (body?.result?.rows ?? []).length === 0);
  }
  // 日付が不正な行は捨てる
  r = await getDeposits({}, [TOKEN, "2026-10"], mk({ ...GOOD, rows: [{ store: "A店", date: "SECRET", amount: 1, count: 1, status: "deposited" }] }));
  eq("日付が不正な行は出さない", (r.body as any).result.rows, []);
  // DB のエラーはそのまま投げる（index.ts の共通の処理が、汎用の文言にする）
  let thrown = false; try { await getDeposits({}, [TOKEN, "2026-10"], async () => { throw new Error("database"); }); } catch { thrown = true; }
  yes("DB エラーは呼び出し側へ投げる", thrown);
});

// ---- ②結合: 本物の index.ts を起動して HTTP で叩く ----
Deno.test("結合: 本物の seisan-api（index.ts）+ 偽の PostgREST", async () => {
  const rpcLog: { name: string; body: any }[] = [];
  let reply: any = GOOD;
  const fake = Deno.serve({ port: 8931, onListen() {} }, async (req) => {
    const u = new URL(req.url);
    const m = u.pathname.match(/\/rest\/v1\/rpc\/(\w+)$/);
    if (m) {
      const body = await req.json().catch(() => ({}));
      rpcLog.push({ name: m[1], body });
      if (m[1] === "settle_client_deposits") return new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } });
      if (m[1] === "settle_read" || m[1] === "settle_whoami") return new Response("null", { headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  });
  const dir = new URL("../supabase/functions/seisan-api/", import.meta.url).pathname;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--no-lock", dir + "index.ts"],
    env: { SUPABASE_URL: "http://127.0.0.1:8931", SUPABASE_SERVICE_ROLE_KEY: "service-test-key-not-real", SUPABASE_ANON_KEY: "anon-test-key-not-real" },
    stdout: "null", stderr: "null",
  }).spawn();
  const base = "http://127.0.0.1:8000";
  const post = async (b: unknown) => { const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, cc: r.headers.get("cache-control"), cors: r.headers.get("access-control-allow-origin"), json: await r.json() }; };
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(base, { method: "OPTIONS" }); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    let r = await post({ fn: "sd_getDeposits", args: [TOKEN, "2026-10"] });
    eq("結合: 正常", [r.status, r.json.ok, r.json.result.rows.length, r.cc, r.cors], [200, true, 2, "no-store", "https://mirai-oss.github.io"]);
    eq("結合: RPC へ渡したのは p_token と p_month だけ", rpcLog.at(-1), { name: "settle_client_deposits", body: { p_token: TOKEN, p_month: "2026-10" } });
    const n0 = rpcLog.length;
    r = await post({ fn: "sd_getDeposits", args: [TOKEN, "2026-10"], store_id: "x" }); eq("結合: 未知のフィールドは 400", r.status, 400);
    r = await post({ fn: "sd_getDeposits", args: [TOKEN, "2026-10", "storeX"] }); eq("結合: 引数 3 つは 400", r.status, 400);
    r = await post({ fn: "sd_getDeposits", args: ["short", "2026-10"] }); eq("結合: 短いトークンは 401 AUTH（既存と同じ）", [r.status, r.json.error], [401, "AUTH"]);
    r = await post({ fn: "sd_getDeposits", args: [TOKEN, "2026-99"] }); eq("結合: 月が不正", r.json.ok, false);
    eq("結合: 拒否した呼び出しでは DB を呼んでいない", rpcLog.length, n0);
    for (const [st, status, err] of [["denied", 200, "DEPOSIT_DENIED"], ["relogin", 200, "DEPOSIT_RELOGIN"], ["rate", 429, "DEPOSIT_RATE"], ["auth", 401, "AUTH"]] as const) {
      reply = { status: st }; r = await post({ fn: "sd_getDeposits", args: [TOKEN, "2026-10"] }); eq(`結合: ${st}`, [r.status, r.json.error], [status, err]);
    }
    reply = { status: "weird" }; r = await post({ fn: "sd_getDeposits", args: [TOKEN, "2026-10"] });
    eq("結合: 想定外の状態は汎用のエラー（中身なし）", [r.json.ok, "result" in r.json, String(r.json.error).includes("処理に失敗")], [false, false, true]);
    // 既存の動作が変わっていない
    r = await post({ fn: "sd_getDashboard", args: [TOKEN, "2026-10"] }); eq("既存: sd_getDashboard（ログイン無し）は従来どおり 401 AUTH", [r.status, r.json.error], [401, "AUTH"]);
    r = await post({ fn: "sd_unknownThing", args: [TOKEN] }); eq("既存: 未知の機能は従来の案内", r.json.error, "この機能は、移行の次の段階で使えるようになります");
    r = await post({ fn: "sd_addRows", args: ["short"] }); eq("既存: 書き込み系は短いトークンで 401", r.status, 401);
    const g = await fetch(base); eq("既存: GET は 405", g.status, 405); await g.body?.cancel();
    const o = await fetch(base, { method: "OPTIONS" }); eq("既存: OPTIONS は CORS", o.headers.get("access-control-allow-origin"), "https://mirai-oss.github.io"); await o.body?.cancel();
  } finally { try { child.kill(); } catch { /* 終了済み */ } await child.status.catch(() => {}); await fake.shutdown(); }
  console.log(`  （検査 ${n} 件）`);
});

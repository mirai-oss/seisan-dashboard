// 精算ダッシュボードの新しい窓口（移行中）。今のGASと同じ {fn, args} の形で受け、{ok, result} を返す。
// 認証: ログイン用トークン（新しい窓口のログイン、または今のダッシュボードのログイン）。
// 書き込みは、切り替え（settle_config の mode='live'）までデータベース側と auth.ts の両方で断る。
// トークン・パスワード・中身はログに出さない。
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildDashboard } from "./dashboard.ts";
import * as auth from "./auth.ts";
import { buildSettings } from "./settings.ts";
import * as files from "./files.ts";
import * as issue from "./issue.ts";
import * as jobs from "./jobs.ts";
import * as ext from "./ext.ts";
import * as deposits from "./deposits.ts";
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

// PDF作成とメール送信の係（今のGAS）。合言葉が未設定のうちは使えない
const WORKER_URL = "https://script.google.com/macros/s/AKfycbzwYN9uSEtcJHSKSVQCoQOrllhO7G6gR-E4dvP-V4o_VdGXr9VQx2mbYYPNyNEFSQCiKg/exec";
async function worker(job: Record<string, unknown>) {
  const secret = Deno.env.get("SEISAN_WORKER_SECRET");
  if (!secret) throw new auth.AppError("PDFとメールの準備がまだです（合言葉が未設定です）");
  const res = await fetch(WORKER_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ fn: "sd_apiWorker", args: [secret, job] }) });
  const out: any = await res.json().catch(() => null);
  if (!out?.ok || !out.result?.ok) { console.error("worker failed", String(job.type)); throw new auth.AppError("PDF・メールの処理に失敗しました" + (out?.result?.error ? "：" + out.result.error : "")); }
  return out.result;
}
const sendMail = async (to: string, subject: string, body: string) => { await worker({ type: "mail", to, subject, body, senderName: "N-Style 精算ダッシュボード", noReply: true }); };

const deps: auth.Deps = {
  store: supaStore(db), fetch, googleClientId: GOOGLE_CLIENT_ID,
  portal: { url: URL_, key: Deno.env.get("SUPABASE_ANON_KEY")! },
  notify: notifySlack,
  sendMail: Deno.env.get("SEISAN_WORKER_SECRET") ? sendMail : undefined,
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

// 毎日の定期処理（係のGASが朝に呼ぶ）。合言葉が合うときだけ。切り替え前は何もしない
async function runDaily(secret: unknown) {
  const want = Deno.env.get("SEISAN_WORKER_SECRET") ?? "";
  if (want.length < 32 || (await auth.sha256hex(String(secret ?? ""))) !== (await auth.sha256hex(want))) throw new auth.AppError("unauthorized");
  const today = jst(new Date()).slice(0, 10);
  const data: any = await rpc("settle_system_data", {});
  if (data.mode !== "live") return { ok: true, skipped: "切り替え前" };
  const j = jobs.jobsFor(today), done: string[] = [];
  if (j.prepare) {
    const r: any = await rpc("settle_prepare_month", { actor: { name: "自動(毎月1日)", role: "マスター" }, p_month: j.prevMonth, p_skip_locked: true });
    done.push("定期費目: " + r.results.join(" / "));
  }
  if (j.cash) {
    const r: any = await rpc("settle_cash_apply", { actor: { name: "自動(毎月5日)", role: "本部" }, p_month: j.prevMonth, p_stores: null, p_skip_existing: true });
    done.push("現金売上: " + r.results.join(" / "));
  }
  let slack = null;
  if (j.remind) slack = jobs.remindMessage({ ...data, thisMonth: today.slice(0, 7) }, today);
  return { ok: true, done, slack };
}
const actorOf = ({ token: _t, ...u }: auth.User) => u; // データベースの記録にトークンを残さない
const bucket = () => db.storage.from("settle-files");
const monthLabel = (m: string) => `${Number(m.slice(0, 4))}年${Number(m.slice(5, 7))}月`;
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(name, args);
  if (!error) return data;
  // 関数が自分で出した案内（raise exception）だけを画面に返す
  if (error.code === "P0001") throw new DbError(error.message);
  console.error("rpc error", name, error.code);
  throw new Error("database");
}

async function issueData(token: string) {
  const r: any = await rpc("settle_issue_data", { p_token: token });
  if (!r) throw new auth.AppError("AUTH");
  return { ...r.data, thisMonth: jst(new Date()).slice(0, 7) };
}
// 管理システムへ発行を知らせる（請求書の下書き用。失敗しても発行は止めない）
async function notifyPortal(store: string, month: string, s: any, resend: boolean, fileName: string, b64: string) {
  const token = Deno.env.get("PL_SYNC_TOKEN");
  if (!token) return { ok: false, error: "PL_SYNC_TOKEN未設定" };
  try {
    const res = await fetch(URL_ + "/functions/v1/invoice-auto-sales", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "seisan_issued", token, store, month, transfer: s.transfer, transfer_ex: s.transferEx, tax: s.tax, resend, pdf: { file_name: fileName, base64: b64 } }) });
    return { ok: res.ok };
  } catch { return { ok: false }; }
}

// ---------- 外の仕組みの受け口（サーバー間の共有トークン PL_SYNC_TOKEN で認証） ----------
const EXT_THROWS = ["sd_apiTransferEx", "sd_apiCategorizedLines", "sd_apiCashSync"]; // 今のGASで、認証失敗が呼び出し全体の失敗になるもの
const ym = (m: unknown) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m ?? ""));
const sysData = async () => await rpc("settle_system_data", {}) as any;
const thisMonth = () => jst(new Date()).slice(0, 7);
const EXT: Record<string, (a: any[]) => Promise<unknown>> = {
  sd_apiTransferEx: async ([s, m]) => ext.transferEx(await sysData(), String(s), String(m), thisMonth()),
  sd_apiCategorizedLines: async ([s, m]) => ext.categorizedLines(await sysData(), String(s), String(m)),
  sd_apiGetLines: async ([items]) => Array.isArray(items) && items.length ? ext.getLines(await sysData(), items) : { ok: true, lines: [] },
  sd_apiDebugExtRef: async ([s, m]) => ext.debugExtRef(await sysData(), String(s), String(m)),
  sd_apiSuggestMapping: async ([p]) => {
    const r = ext.resolveMapping(await sysData(), String(p?.store ?? ""), String(p?.mfAccount ?? "").trim(), String(p?.mfSubAccount ?? "").trim(), String(p?.vendor ?? "").trim(), String(p?.item ?? "").trim());
    return r ? { ok: true, resolved: true, account: r.account, source: r.source } : { ok: true, resolved: false };
  },
  sd_apiConfirmMapping: async ([p]) => {
    const mf = String(p?.mfAccount ?? "").trim(), on = p?.onOff !== false && p?.onOff !== "OFF", account = String(p?.account ?? "").trim();
    if (!mf) return { ok: false, error: "mfAccountが空です" };
    if (on && !account) return { ok: false, error: "PL対象ONの場合はaccount（PL表示科目）が必須です" };
    const { error } = await db.from("settle_pl_mappings").upsert({ mf_account: mf, mf_sub: String(p?.mfSubAccount ?? "").trim(), vendor: String(p?.vendor ?? "").trim(), on_off: on, account: on ? account : "", updated_at: jst(new Date()).slice(0, 16).replace("T", " "), updated_by: String(p?.user ?? "") }, { onConflict: "mf_account,mf_sub,vendor" });
    if (error) throw new Error("database");
    return { ok: true };
  },
  sd_apiMarkPlSynced: async ([store, m, result]) => {
    if (!ym(m)) return { ok: false, error: "年月が不正です（例: 2026-08）" };
    if (!store) return { ok: false, error: "店舗名が空です" };
    const now = new Date().toISOString(), ok = !!result?.ok;
    const prev = await db.from("settle_pl_sync_logs").select("last_ok_at").eq("store", store).eq("month", m).maybeSingle();
    const { error } = await db.from("settle_pl_sync_logs").upsert({ store, month: m, ok, last_ok_at: ok ? String(result?.syncedAt || now) : prev.data?.last_ok_at ?? "", error: ok ? "" : String(result?.error ?? ""), last_attempt_at: now });
    if (error) throw new Error("database");
    return { ok: true };
  },
  sd_apiAddExternalLine: async ([store, m, line]) => {
    const p: any = { ...(line ?? {}) };
    let account = String(p.account ?? "").trim(), source = account ? "explicit" : "", needs = false;
    if (!account) {
      const r = ext.resolveMapping(await sysData(), String(store), String(p.mfAccount ?? "").trim(), String(p.mfSubAccount ?? "").trim(), String(p.vendor ?? "").trim(), String(p.item ?? "").trim());
      if (r) { account = r.account; source = r.source; } else needs = true;
    }
    try {
      const res: any = await rpc("settle_ext_upsert", { p_store: store, p_month: m, p: { ...p, account } });
      return res.ok ? { ...res, account, needsMapping: needs, mappingSource: source } : res;
    } catch (e) { if (e instanceof auth.AppError) return { ok: false, error: e.message }; throw e; }
  },
  sd_apiRemoveExternalLine: async ([store, m, key]) => {
    try { return { ok: true, result: await rpc("settle_ext_remove", { p_store: store, p_month: m, p_key: key }) }; }
    catch (e) { if (e instanceof auth.AppError) return { ok: false, error: e.message }; throw e; }
  },
  sd_apiUploadAttachment: async ([store, m, p]) => {
    if (!ym(m)) return { ok: false, error: "年月が不正です（例: 2026-08）" };
    if (!String(p?.kind ?? "").trim()) return { ok: false, error: "費目名（kind）が空です" };
    const bytes = files.decodeB64(p?.b64);
    if (!bytes) return { ok: false, error: "ファイルデータ（b64）が空か、大きすぎます" };
    if ((await deps.store.mode()) !== "live") return { ok: false, error: "切り替え前のため、ここには保存できません" };
    const d = await sysData(), st = d.stores.find((s: any) => s.name === store);
    if (!st) return { ok: false, error: "店舗が見つかりません: " + store };
    if (ext.isLocked(d, st, m)) return { ok: false, error: m + "分は振込済み（確定済み）のためアップロードできません", locked: true };
    const uniq = String(p.uniq ?? "").replace(/[^0-9A-Za-z]/g, "").slice(0, 8);
    const n = files.attachmentName(p.kind, m, store, p.fileName, false, []);
    const name = uniq ? n.name.slice(0, n.name.length - n.ext.length) + "__" + uniq + n.ext : n.name;
    const path = `files/${m}/${crypto.randomUUID()}${n.ext.toLowerCase()}`, mime = files.safeMime(p.mimeType);
    if ((await bucket().upload(path, bytes, { contentType: mime })).error) return { ok: false, error: "ファイルの保存に失敗しました" };
    const ins = await db.from("settle_attachments").insert({ store_key: st.store_key, month: m, file_name: name, storage_path: path, mime, size_bytes: bytes.length, uploaded_by: "自動連携" }).select("id").single();
    if (ins.error) { await bucket().remove([path]); return { ok: false, error: "記録に失敗しました" }; }
    // 同じ名前の古いものは消した印を付ける（今の仕組みの上書きと同じ）
    await db.from("settle_attachments").update({ deleted_at: new Date().toISOString(), deleted_by: "自動連携（差し替え）" }).eq("store_key", st.store_key).eq("month", m).eq("file_name", name).neq("id", ins.data.id).is("deleted_at", null);
    return { ok: true, name, url: (await bucket().createSignedUrl(path, 3600)).data?.signedUrl ?? "" };
  },
  sd_apiGetSettlementPdf: async ([store, m]) => {
    if (!ym(m)) return { ok: false, error: "年月が不正です（例: 2026-09）" };
    try {
      const d = await sysData();
      const model = issue.statementModel({ ...d, thisMonth: thisMonth() }, { name: "自動連携", role: "マスター" }, String(store), String(m));
      if (!model) return { ok: false, error: "店舗が見つかりません: " + store };
      const pdf = await worker({ type: "pdf", model });
      return { ok: true, file_name: issue.pdfName(model.store, String(m), false), base64: pdf.b64 };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  sd_apiCashSync: async ([m, names]) => {
    if (!ym(m)) throw new auth.AppError("monthKey は YYYY-MM 形式");
    const list = (Array.isArray(names) ? names : []).map((x: any) => String(x ?? "").trim()).filter(Boolean);
    if (!list.length) return { ok: true, results: ["対象店舗がありません"] };
    await worker({ type: "pushSales", month: m }); // レジの値を直した直後に呼ばれるので、売上を取り込み直してから反映する
    const d = await sysData(), results: string[] = [], allowed: string[] = [];
    for (const n of list) {
      const st = d.stores.find((s: any) => s.name === n);
      if (st && ext.isLocked(d, st, m)) results.push(n + ": 振込済みのため更新しません（精算書の現金売上は手動で確認してください）"); else allowed.push(n);
    }
    if (!allowed.length) return { ok: true, results };
    const r: any = await rpc("settle_cash_apply", { actor: { name: "レジ照合(自動)", role: "本部" }, p_month: m, p_stores: allowed, p_skip_existing: false });
    return { ok: true, results: results.concat(r.results) };
  },
};
async function runExt(fn: string, args: any[]) {
  const [token, ...rest] = args;
  const want = (Deno.env.get("PL_SYNC_TOKEN") ?? "").trim();
  if (!want || (await auth.sha256hex(String(token ?? "").trim())) !== (await auth.sha256hex(want))) {
    if (EXT_THROWS.includes(fn)) throw new auth.AppError("unauthorized");
    return { ok: false, error: "unauthorized" };
  }
  return await EXT[fn](rest);
}

// ログインが必要なもの（a は、トークンより後ろの引数）
const AUTHED: Record<string, (u: auth.User, a: any[]) => Promise<unknown>> = {
  sd_addRows: (u, a) => rpc("settle_add_rows", { actor: actorOf(u), p: a[0] }),
  sd_updateRow: (u, a) => rpc("settle_update_row", { actor: actorOf(u), p: a[0] }),
  sd_deleteRow: (u, a) => rpc("settle_delete_row", { actor: actorOf(u), p: a[0] }),
  sd_bulkAdd: (u, a) => rpc("settle_bulk_add", { actor: actorOf(u), p: a[0] }),
  sd_setPaid: async (u, a) => { // a = [委託先, 月, 振込済みか, メールも送るか, 金額]
    const r: any = await rpc("settle_set_paid", { actor: actorOf(u), p_client: a[0], p_month: a[1], p_done: !!a[2], p_amount: a[4] ?? null });
    if (!r.done) return { ...r, mailed: false, mailedStores: [] };
    const warnings: string[] = [];
    await worker({ type: "dispatchPl", month: a[1] }).catch(() => warnings.push("PL同期を起動できませんでした"));
    const mailedStores: string[] = [];
    if (a[3]) {
      const d: any = await issueData(u.token!);
      for (const name of r.members as string[]) {
        const st = d.stores.find((s: any) => s.name === name);
        const m = st && issue.paidMail(st, d.settings, a[1], d, u);
        if (!m) continue;
        try {
          await worker({ type: "mail", ...m });
          await rpc("settle_record_issue", { actor: actorOf(u), p: { action: "振込完了メール", store: name, month: a[1], fileName: m.subject, to: m.to } });
          mailedStores.push(name);
        } catch { warnings.push(name + ": 振込完了メールを送れませんでした"); }
      }
    }
    return { ...r, mailed: mailedStores.length > 0, mailedStores, warnings };
  },
  sd_issueAndSend: async (u, a) => { // a = [店舗, 月, メールも送るか]
    const [store, month, doMail] = [String(a[0] ?? ""), String(a[1] ?? ""), !!a[2]];
    if (u.role !== "本部" && u.role !== "マスター") throw new auth.AppError("この操作は本部アカウントのみ実行できます");
    if ((await deps.store.mode()) !== "live") throw new auth.AppError("切り替え前のため、ここでは発行できません。いつもの画面で行ってください");
    const d: any = await issueData(u.token!);
    const model = issue.statementModel(d, u, store, month);
    if (!model) throw new auth.AppError("店舗が見つかりません: " + store);
    const st = d.stores.find((s: any) => s.name === store);
    const resend = doMail && d.logs.some((l: any) => l.store === store && l.month === month && l.action === "メール送信");
    if (doMail && !String(st.mail?.to ?? "").trim()) throw new auth.AppError("「" + store + "」の宛先(To)がありません");
    const pdf = await worker({ type: "pdf", model });
    const bytes = files.decodeB64(pdf.b64)!;
    const fileName = issue.pdfName(store, month, resend);
    const path = `files/${month}/${crypto.randomUUID()}.pdf`;
    if ((await bucket().upload(path, bytes, { contentType: "application/pdf" })).error) throw new Error("storage");
    const ins = await db.from("settle_attachments").insert({ store_key: st.store_key, month, file_name: fileName, storage_path: path, mime: "application/pdf", size_bytes: bytes.length, uploaded_by: u.name }).select("id").single();
    if (ins.error) throw new Error("database");
    const result: any = { ok: true, fileName, fileId: String(ins.data.id), url: (await bucket().createSignedUrl(path, 3600)).data?.signedUrl ?? "", mailed: false, resend };
    if (doMail) {
      const all = await db.from("settle_attachments").select("file_name,size_bytes,storage_path").eq("store_key", st.store_key).eq("month", month).is("deleted_at", null);
      if (all.error) throw new Error("database");
      const picked = issue.pickAttachments(all.data.map((f: any) => ({ name: f.file_name, size: Number(f.size_bytes ?? 0), path: f.storage_path })), bytes.length);
      const signed = picked.send.length ? await bucket().createSignedUrls(picked.send.map((f) => f.path), 900) : { data: [] as any[], error: null };
      if (signed.error) throw new Error("storage");
      const mail = issue.statementMail(st.mail, d.settings, month, resend, fileName, picked.names);
      const sent = await worker({ type: "mail", ...mail, pdf: { name: fileName, b64: pdf.b64 }, attachments: picked.send.map((f, i) => ({ name: f.name, url: signed.data![i].signedUrl })) });
      Object.assign(result, { mailed: true, to: mail.to, attachCount: sent.attachCount });
      result.portal = await notifyPortal(store, month, model.s, resend, fileName, pdf.b64);
    }
    await rpc("settle_record_issue", { actor: actorOf(u), p: { action: doMail ? "メール送信" : "PDF保存", store, month, fileName, fileId: result.fileId, to: result.to ?? "" } });
    return result;
  },
  sd_listAccessRequests: (u) => auth.listAccessRequests(deps, u),
  sd_approveAccess: (u, a) => auth.approveAccess(deps, u, a[0], a[1]),
  sd_rejectAccess: (u, a) => auth.rejectAccess(deps, u, a[0], a[1]),
  sd_saveAccount: (u, a) => auth.saveAccount(deps, u, a[0]),
  sd_suggestAccount: async (u, a) => {
    if (u.role !== "本部" && u.role !== "マスター") throw new auth.AppError("この操作は本部アカウントのみ実行できます");
    return ext.suggestAccount(await sysData(), String(a[0] ?? ""), String(a[1] ?? ""));
  },
  sd_prepareMonth: (u, a) => rpc("settle_prepare_month", { actor: actorOf(u), p_month: a[0], p_skip_locked: u.role !== "マスター" }),
  sd_cashPreview: (u, a) => rpc("settle_cash_preview", { actor: actorOf(u), p_month: a[0] }),
  sd_cashApply: (u, a) => rpc("settle_cash_apply", { actor: actorOf(u), p_month: a[0], p_stores: Array.isArray(a[1]) ? a[1] : [], p_skip_existing: false }),
  sd_setupAutoPrep: () => Promise.resolve({ ok: true, message: "自動処理は設定済みです（毎月1日 定期費目セット／毎月5日 現金売上取込／17日・20日以降 未処理の通知）" }),
  sd_uploadAttachment: async (u, a) => { // a = [{ store, month, kind, fileName, mimeType, b64, revised }]
    const p: any = a[0] ?? {};
    const t: any = await rpc("settle_file_target", { actor: actorOf(u), p_store: p.store, p_month: p.month });
    const bytes = files.decodeB64(p.b64);
    if (!bytes) throw new auth.AppError("ファイルが読めないか、大きすぎます（25MBまで）");
    const n = files.attachmentName(p.kind, p.month, p.store, p.fileName, !!p.revised, t.names);
    if (!n.kind) throw new auth.AppError("何の書類か（例: カード売上）を入力してください");
    const path = `files/${p.month}/${crypto.randomUUID()}${n.ext.toLowerCase()}`;
    const mime = files.safeMime(p.mimeType);
    const up = await bucket().upload(path, bytes, { contentType: mime });
    if (up.error) throw new Error("storage");
    const ins = await db.from("settle_attachments").insert({ store_key: t.key, month: p.month, file_name: n.name, storage_path: path, mime, size_bytes: bytes.length, uploaded_by: u.name });
    if (ins.error) { await bucket().remove([path]); throw new Error("database"); }
    await db.from("settle_audit").insert({ actor: u.name, action: p.revised ? "添付（修正版）" : "添付アップロード", store_key: t.key, month: p.month, after: { name: n.name } });
    const signed = await bucket().createSignedUrl(path, 3600);
    return { ok: true, name: n.name, url: signed.data?.signedUrl ?? "", folder: monthLabel(p.month) + "／" + p.store };
  },
  sd_deleteAttachment: (u, a) => rpc("settle_file_delete", { actor: actorOf(u), p_store: a[0], p_month: a[1], p_id: String(a[2] ?? "") }),
  sd_saveTerms: (u, a) => rpc("settle_save_terms", { actor: actorOf(u), p: a[0] }),
  sd_deleteTerms: (u, a) => rpc("settle_delete_terms", { actor: actorOf(u), p: a[0] }),
  sd_saveRecurring: (u, a) => rpc("settle_save_recurring", { actor: actorOf(u), p: a[0] }),
  sd_saveMail: (u, a) => rpc("settle_save_mail", { actor: actorOf(u), p: a[0] }),
  sd_saveCorp: (u, a) => rpc("settle_save_corp", { actor: actorOf(u), p: a[0] }),
  sd_saveOpsSettings: (u, a) => rpc("settle_save_ops", { actor: actorOf(u), p: a[0] }),
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POSTのみ対応" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "リクエストの解析に失敗しました" }, 400); }
  const fn = String(body?.fn ?? ""), args: any[] = Array.isArray(body?.args) ? body.args : [];
  const t0 = Date.now();
  try {
    if (fn === "sd_cronDaily") return json({ ok: true, result: await runDaily(args[0]) });
    if (Object.hasOwn(EXT, fn)) return json({ ok: true, result: await runExt(fn, args) });
    if (Object.hasOwn(PUBLIC, fn)) return json({ ok: true, result: await PUBLIC[fn](args) });
    const READS = ["sd_getDashboard", "sd_getSettings", "sd_getOpsSettings", "sd_listAttachments", "sd_getPdfB64", "sd_pdfPreview", "sd_getDeposits"];
    if (!READS.includes(fn) && !Object.hasOwn(AUTHED, fn)) return json({ ok: false, error: "この機能は、移行の次の段階で使えるようになります" });
    const [token, ...rest] = args;
    if (typeof token !== "string" || token.length < 32) return json({ ok: false, error: "AUTH" }, 401);

    if (fn === "sd_getDeposits") { // [トークン, 月]。委託先の入金タブ。判定は全てDB側（settle_client_deposits）。引数はこの2つだけ
      const r = await deposits.getDeposits(body, args, rpc);
      return json(r.body, r.status);
    }

    if (fn === "sd_getDashboard") {
      const month = rest[0] ?? null;
      if (month != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month))) return json({ ok: false, error: "対象月の形式が不正です" });
      const data: any = await rpc("settle_read", { p_token: token });
      if (!data) return json({ ok: false, error: "AUTH" }, 401);
      const readMs = Date.now() - t0;
      const result: any = buildDashboard({ ...data.data, thisMonth: jst(new Date()).slice(0, 7) }, data.user, month);
      const live = (await deps.store.mode()) === "live";
      result.ver = live ? "v6.0" : "db-test";
      result.sheetUrl = "";
      result.updatedAt = jst(live ? new Date() : new Date(data.importedAt)).slice(0, 16).replace("T", " ");
      result._ms = { read: readMs, total: Date.now() - t0 };
      return json({ ok: true, result });
    }

    if (fn === "sd_getSettings" || fn === "sd_getOpsSettings") {
      const d: any = await rpc("settle_settings", { p_token: token });
      if (!d) return json({ ok: false, error: "AUTH" }, 401);
      if (d.forbidden) return json({ ok: false, error: "この操作は本部アカウントのみ実行できます" });
      return json({ ok: true, result: fn === "sd_getOpsSettings" ? { ok: true, ...d.ops } : buildSettings(d, jst(new Date()).slice(0, 7)) });
    }

    if (fn === "sd_listAttachments") { // [店舗, 月]
      const list: any = await rpc("settle_file_list", { p_token: token, p_store: String(rest[0] ?? ""), p_month: String(rest[1] ?? "") });
      if (!list) return json({ ok: false, error: "AUTH" }, 401);
      if (!list.length) return json({ ok: true, result: [] });
      const signed = await bucket().createSignedUrls(list.map((f: any) => f.path), 3600); // 1時間だけ開けるリンク
      if (signed.error) throw new Error("storage");
      const url = new Map(signed.data.map((s: any) => [s.path, s.signedUrl]));
      return json({ ok: true, result: list.map((f: any) => ({ id: f.id, name: f.name, date: f.date, url: url.get(f.path) ?? "" })) });
    }
    if (fn === "sd_pdfPreview") { // [店舗, 月]。読むだけなので、切り替え前でも使える
      const d: any = await issueData(token);
      const u: any = await rpc("settle_whoami", { p_token: token });
      const model = issue.statementModel(d, u, String(rest[0] ?? ""), String(rest[1] ?? ""));
      if (!model) return json({ ok: false, error: "この店舗の閲覧権限がありません" });
      const pdf = await worker({ type: "pdf", model });
      return json({ ok: true, result: { fileName: issue.pdfName(model.store, model.monthKey, false), b64: pdf.b64 } });
    }
    if (fn === "sd_getPdfB64") {
      const f: any = await rpc("settle_file_get", { p_token: token, p_file: String(rest[0] ?? "") });
      if (!f) return json({ ok: false, error: "AUTH" }, 401);
      const dl = await bucket().download(f.path);
      if (dl.error) throw new Error("storage");
      return json({ ok: true, result: { fileName: f.name, b64: files.encodeB64(new Uint8Array(await dl.data.arrayBuffer())) } });
    }

    const user: any = await rpc("settle_whoami", { p_token: token });
    if (!user) return json({ ok: false, error: "AUTH" }, 401);
    return json({ ok: true, result: await AUTHED[fn]({ ...user, token }, rest) });
  } catch (e) {
    if (e instanceof auth.AppError) return json({ ok: false, error: e.message });
    console.error("seisan-api error", fn, (e as Error)?.name);
    return json({ ok: false, error: "処理に失敗しました。少し時間をおいて、もう一度お試しください" });
  }
});

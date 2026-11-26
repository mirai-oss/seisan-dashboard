// auth.ts が使うデータの出し入れ口（Supabaseの表）。service_role の接続だけで使う。
import type { Store } from "./auth.ts";

export function supaStore(db: any): Store {
  const must = async (q: any) => { const { data, error } = await q; if (error) { console.error("store error", error.code); throw new Error("database"); } return data; };
  return {
    mode: async () => (await must(db.from("settle_config").select("value").eq("key", "mode").maybeSingle()))?.value ?? "copy",
    accounts: async () => must(db.from("settle_accounts").select("login_id,pw_hash,name,role,stores_raw,enabled,email").order("sort_order").limit(1000)),
    insertAccount: async (a) => { await must(db.from("settle_accounts").insert(a)); },
    updateAccount: async (id, patch) => { await must(db.from("settle_accounts").update(patch).eq("login_id", id)); },
    createSession: async (token_hash, login_id, expires_at) => { await must(db.from("settle_sessions").insert({ token_hash, login_id, expires_at })); },
    deleteSessions: async (login_id) => { await must(db.from("settle_sessions").delete().eq("login_id", login_id)); },
    revokeSnapshots: async () => { await must(db.rpc("sd_dash_revoke_all")); },
    failState: async (key) => {
      const r = await must(db.from("settle_login_fails").select("fails,until").eq("key", key).maybeSingle());
      return r && new Date(r.until).getTime() > Date.now() ? r.fails : 0;
    },
    addFail: async (key) => { await must(db.rpc("settle_add_fail", { p_key: key, p_minutes: key.startsWith("accreq|") ? 1440 : key.startsWith("reset|") ? 60 : 15 })); },
    clearFail: async (key) => { await must(db.from("settle_login_fails").delete().eq("key", key)); },
    log: async (event, who, result) => { await db.from("settle_auth_logs").insert({ event, who: String(who ?? "").slice(0, 80), result }); },
    putResetToken: async (token_hash, login_id, expires_at) => {
      await must(db.from("settle_reset_tokens").delete().eq("login_id", login_id));
      await must(db.from("settle_reset_tokens").insert({ token_hash, login_id, expires_at }));
    },
    takeResetToken: async (token_hash) => {
      const r = await must(db.from("settle_reset_tokens").delete().eq("token_hash", token_hash).gt("expires_at", new Date().toISOString()).select("login_id"));
      return r?.[0]?.login_id ?? null;
    },
    requests: async () => must(db.from("settle_access_requests").select("*").order("at", { ascending: false }).limit(500)),
    insertRequest: async (r) => { await must(db.from("settle_access_requests").insert(r)); },
    updateRequest: async (id, patch) => { await must(db.from("settle_access_requests").update(patch).eq("id", id)); },
  };
}

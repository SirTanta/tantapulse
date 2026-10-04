/**
 * GET|POST /api/pulse/retention-purge
 *
 * Daily 24-month retention pass for Tanta Pulse personal data (MCA-1970). See
 * lib/pulse-retention.mjs for exactly what is removed/anonymized and what is never touched.
 *
 * DRY-RUN BY DEFAULT: nothing is deleted or modified unless the environment variable
 * PULSE_RETENTION_PURGE_ENABLED is exactly "true". Every run records a heartbeat
 * (job pulse_retention_purge) with the mode and counts.
 *
 * Auth: Authorization: Bearer $CRON_SECRET (Vercel cron sends this). Fails closed.
 */
import { runRetention } from "../../lib/pulse-retention.mjs";
import { recordHeartbeat } from "../../lib/pulse-heartbeat.mjs";

export function retentionDb(env = process.env, fetchImpl = (...a) => fetch(...a)) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL || env.THOS_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.THOS_SUPABASE_SERVICE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  async function call(method, path, body, extra = {}) {
    const res = await fetchImpl(`${url}/rest/v1/${path}`, {
      method,
      headers: { ...headers, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`db ${method} ${path.split("?")[0]} ${res.status}: ${text.slice(0, 200)}`);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }
  return {
    ok: Boolean(url && key),
    get: (p) => call("GET", p),
    patch: (p, b) => call("PATCH", p, b, { Prefer: "return=minimal" }),
    del: (p) => call("DELETE", p, undefined, { Prefer: "return=minimal" }),
    insert: (p, b, extra) => call("POST", p, b, extra || { Prefer: "return=minimal" }),
  };
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const d = retentionDb();
  if (!d.ok) {
    await recordHeartbeat("pulse_retention_purge", false, { reason: "missing_configuration" });
    return res.status(500).json({ error: "Missing configuration" });
  }
  const apply = process.env.PULSE_RETENTION_PURGE_ENABLED === "true";
  try {
    const result = await runRetention(d, { apply });
    const ok = result.errors.length === 0;
    await recordHeartbeat("pulse_retention_purge", ok, {
      mode: result.mode,
      cutoff: result.cutoff,
      counts: result.counts,
      errors: result.errors,
    });
    console.log(`[pulse-retention] ${JSON.stringify(result)}`);
    return res.status(ok ? 200 : 500).json({ ok, ...result });
  } catch (err) {
    await recordHeartbeat("pulse_retention_purge", false, { mode: apply ? "apply" : "dry_run", error: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }
}

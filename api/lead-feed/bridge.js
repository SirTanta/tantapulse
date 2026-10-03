/**
 * GET|POST /api/lead-feed/bridge
 *
 * Connects lead_feed_leads (Apify discovery pool) to the existing, unmodified
 * outreach() sender in api/sample-intake/fulfill.js. See lib/lead-feed-bridge.mjs
 * for the full explanation. This route never sends email and never touches
 * OUTREACH_DAILY_CAP / OUTREACH_PASS_CAP -- it only creates leads/contacts rows
 * that the existing sender's own eligibility query will find on its next pass.
 *
 * Auth: Authorization: Bearer $CRON_SECRET (Vercel cron sends this). Fails closed.
 */
import { runBridge, BRIDGE_BATCH_SIZE } from "../../lib/lead-feed-bridge.mjs";

function db() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.THOS_SUPABASE_SERVICE_KEY;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  async function call(method, path, body, extra = {}) {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      method,
      headers: { ...headers, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* noop */
    }
    if (!res.ok)
      throw new Error(
        `db ${method} ${path.split("?")[0]} ${res.status}: ${text.slice(0, 200)}`,
      );
    return json;
  }
  return {
    ok: Boolean(url && key),
    get: (p) => call("GET", p),
    insert: (p, b) => call("POST", p, b, { Prefer: "return=representation" }),
    patch: (p, b) => call("PATCH", p, b, { Prefer: "return=minimal" }),
  };
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const d = db();
  const hunterKey = process.env.HUNTER_IO_API_KEY;
  if (!d.ok || !hunterKey) {
    return res.status(500).json({ error: "Missing configuration" });
  }
  const limit = Number(req.query?.limit || BRIDGE_BATCH_SIZE);
  const log = [];
  try {
    const result = await runBridge(d, hunterKey, log, limit);
    return res.status(200).json({ ok: true, ...result, log });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, log });
  }
}

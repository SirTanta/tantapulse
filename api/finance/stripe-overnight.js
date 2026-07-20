import { makeReceipt, runStripeOvernightIngestion } from "../../lib/finance-stripe-overnight.mjs";

function supabaseHeaders(key, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extra };
}

async function postJson(url, body, headers) {
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: response.ok, status: response.status, json };
}

function createStore({ supabaseUrl, supabaseKey, accountId }) {
  const base = `${supabaseUrl.replace(/\/$/, "")}/rest/v1`;
  return {
    async persistNewSignals(signals) {
      const rows = signals.map((signal) => ({
        dedupe_key: signal.dedupeKey,
        account_id: accountId,
        entity_id: signal.entityId,
        signal_key: signal.signalKey,
        signal_type: signal.signalType,
        event_type: signal.eventType,
        event_date: signal.eventDate,
      }));
      const result = await postJson(`${base}/rpc/persist_finance_signals_atomically`, { signal_rows: rows }, supabaseHeaders(supabaseKey));
      if (!result.ok || !Array.isArray(result.json) || result.json.length !== 1) throw new Error(`atomic finance signal persistence failed: ${result.status}`);
      return result.json[0];
    },
    async recordReceipt(receipt) {
      const result = await postJson(`${base}/quiet_receipt_log`, [receipt], supabaseHeaders(supabaseKey, { Prefer: "return=minimal" }));
      if (!result.ok) throw new Error(`finance receipt persistence failed: ${result.status}`);
    },
  };
}

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers?.authorization === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.THOS_SUPABASE_SERVICE_KEY;
  const accountId = process.env.STRIPE_ACCOUNT_ID;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!supabaseUrl || !supabaseKey || !accountId || !stripeKey) {
    return res.status(503).json({ error: "Finance ingestion is not configured" });
  }

  const store = createStore({ supabaseUrl, supabaseKey, accountId });
  try {
    const receipt = await runStripeOvernightIngestion({ accountId, stripeKey, store });
    return res.status(200).json({ ok: true, receipt });
  } catch (error) {
    const receipt = makeReceipt({ now: new Date(), windowOpen: false, mode: "error" });
    try { await store.recordReceipt(receipt); } catch {}
    console.error("[Stripe finance ingestion] failed", error.message);
    return res.status(502).json({ error: "Finance ingestion failed", receipt });
  }
}

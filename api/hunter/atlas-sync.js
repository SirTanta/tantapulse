/**
 * Atlas ingestion sender - server-only delivery drain.
 *
 * Reads the TantaPulse-owned delivery ledger and (re)delivers confirmed
 * lifecycle facts to Atlas under the same event_id. It never calls Hunter,
 * never enrolls a prospect, never sends outreach, and is not registered as a
 * Vercel cron: activation is a separate, deliberate operator change.
 *
 * Env:
 *   CRON_SECRET                 scheduler bearer token
 *   CRM_INGESTION_ENDPOINT      full Atlas ingestion URL (never hardcoded)
 *   HOLDINGS_INGESTION_SECRET   HMAC-SHA256 signing secret (server-only)
 *   NEXT_PUBLIC_SUPABASE_URL / THOS_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY / THOS_SUPABASE_SERVICE_KEY
 */

import { deliverConfirmedFact, parseOutcomeKey } from "../../lib/hunter-atlas-sender.mjs";

const DEFAULT_BATCH_LIMIT = 50;

function supabaseHeaders(key, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extra };
}

async function readRows(url, headers) {
  const response = await fetch(url, { method: "GET", headers });
  if (!response.ok) throw new Error(`supabase read failed: ${response.status}`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

async function readCount(url, headers) {
  const response = await fetch(url, { method: "HEAD", headers: { ...headers, Prefer: "count=exact" } });
  if (!response.ok) throw new Error(`supabase count failed: ${response.status}`);
  const range = response.headers.get("content-range") || "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

export function createStore({ supabaseUrl, supabaseKey }) {
  const base = `${supabaseUrl.replace(/\/$/, "")}/rest/v1`;
  const headers = supabaseHeaders(supabaseKey);
  const eq = (value) => `eq.${encodeURIComponent(value)}`;

  return {
    async getSuppression(prospectId) {
      const rows = await readRows(`${base}/hunter_suppressions?prospect_id=${eq(prospectId)}&limit=1`, headers);
      return rows[0] ?? null;
    },
    async getProspect(prospectId) {
      const rows = await readRows(`${base}/hunter_prospect_states?prospect_id=${eq(prospectId)}&limit=1`, headers);
      return rows[0] ?? null;
    },
    async getApproval(approvalId) {
      if (!approvalId) return null;
      const rows = await readRows(`${base}/hunter_list_approvals?approval_id=${eq(approvalId)}&limit=1`, headers);
      return rows[0] ?? null;
    },
    async countDeliveredSends(approvalId) {
      return readCount(
        `${base}/atlas_delivery_ledger?select=id&approval_id=${eq(approvalId)}&lifecycle_stage=eq.contacted&attempt_state=eq.delivered`,
        headers,
      );
    },
    async getApprovalMetrics(approvalId) {
      const [bounced, optedOut] = await Promise.all([
        readCount(`${base}/atlas_delivery_ledger?select=id&approval_id=${eq(approvalId)}&lifecycle_stage=eq.bounced&attempt_state=eq.delivered`, headers),
        readCount(`${base}/atlas_delivery_ledger?select=id&approval_id=${eq(approvalId)}&lifecycle_stage=eq.opted_out&attempt_state=eq.delivered`, headers),
      ]);
      return { bounced, opted_out: optedOut };
    },
    async hasDeliveredCreate(prospectId) {
      const rows = await readRows(
        `${base}/atlas_delivery_ledger?select=id&prospect_id=${eq(prospectId)}&event_type=eq.prospect.verified&attempt_state=eq.delivered&limit=1`,
        headers,
      );
      return rows.length > 0;
    },
    async listDeliverable(limit = DEFAULT_BATCH_LIMIT) {
      return readRows(
        `${base}/atlas_delivery_ledger?attempt_state=in.(pending,retry_scheduled)&order=created_at.asc&limit=${Number(limit)}`,
        headers,
      );
    },
    async claimDelivery({ outcomeKey, prospectId, approvalId, eventType, lifecycleStage, occurredAt, normalizedPayload }) {
      const claimUrl = `${base}/atlas_delivery_ledger?outcome_key=${eq(outcomeKey)}&limit=1`;
      const existing = await readRows(claimUrl, headers);
      if (existing.length) return { ...existing[0], duplicate: true };

      // The unique index on outcome_key is the real guard; ignore-duplicates
      // makes a concurrent claim resolve to the same row and the same event_id.
      const insert = await fetch(`${base}/atlas_delivery_ledger?on_conflict=outcome_key`, {
        method: "POST",
        headers: supabaseHeaders(supabaseKey, { Prefer: "resolution=ignore-duplicates,return=minimal" }),
        body: JSON.stringify([{
          outcome_key: outcomeKey,
          prospect_id: prospectId,
          approval_id: approvalId,
          event_type: eventType,
          lifecycle_stage: lifecycleStage,
          occurred_at: occurredAt,
          normalized_payload: normalizedPayload ?? {},
        }]),
      });
      if (!insert.ok) throw new Error(`delivery claim failed: ${insert.status}`);

      const rows = await readRows(claimUrl, headers);
      if (!rows.length) throw new Error("delivery claim did not resolve to a ledger row");
      return { ...rows[0], duplicate: false };
    },
    async recordDeliveryOutcome({ outcomeKey, attemptState, responseStatus, classification, attempts }) {
      const nowIso = new Date().toISOString();
      const response = await fetch(`${base}/atlas_delivery_ledger?outcome_key=${eq(outcomeKey)}`, {
        method: "PATCH",
        headers: supabaseHeaders(supabaseKey, { Prefer: "return=minimal" }),
        body: JSON.stringify({
          attempt_state: attemptState,
          response_status: responseStatus,
          response_classification: classification,
          attempts,
          updated_at: nowIso,
          last_attempted_at: nowIso,
          delivered_at: attemptState === "delivered" ? nowIso : null,
        }),
      });
      if (!response.ok) throw new Error(`delivery outcome persistence failed: ${response.status}`);
    },
  };
}

// A ledger row exists only because the Pulse runtime already confirmed the
// fact, so the row itself is the confirmation reference for a redelivery.
export function factFromLedgerRow(row) {
  const { factKind, outcomeRef } = parseOutcomeKey(row.outcome_key);
  const payload = row.normalized_payload ?? {};
  return {
    kind: factKind,
    prospect_id: row.prospect_id,
    approval_id: row.approval_id,
    occurred_at: row.occurred_at,
    outcome_ref: outcomeRef,
    confirmed_by: `ledger:${row.outcome_key}`,
    prospect: payload.prospect,
    reason: payload.reason,
    revenue: payload.revenue,
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
  const endpoint = process.env.CRM_INGESTION_ENDPOINT;
  const secret = process.env.HOLDINGS_INGESTION_SECRET;
  if (!supabaseUrl || !supabaseKey || !endpoint || !secret) {
    return res.status(503).json({ error: "Atlas ingestion sender is not configured" });
  }

  const store = createStore({ supabaseUrl, supabaseKey });
  const receipt = { delivered: 0, blocked: 0, duplicate: 0, retry_scheduled: 0, considered: 0 };

  try {
    const rows = await store.listDeliverable(DEFAULT_BATCH_LIMIT);
    receipt.considered = rows.length;

    for (const row of rows) {
      const result = await deliverConfirmedFact({ fact: factFromLedgerRow(row), store, endpoint, secret });
      if (result.sent) receipt.delivered += 1;
      else if (result.duplicate) receipt.duplicate += 1;
      else if (result.blocked) receipt.blocked += 1;
      else receipt.retry_scheduled += 1;
    }
    return res.status(200).json({ ok: true, receipt });
  } catch (error) {
    console.error("[Atlas ingestion sender] run halted", error.message);
    return res.status(502).json({ error: "Atlas ingestion run halted for operator review", receipt });
  }
}

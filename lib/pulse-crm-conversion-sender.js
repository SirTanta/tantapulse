/**
 * Sends a Stripe checkout conversion to Atlas CRM's dedicated Tanta Pulse
 * adapter (POST /api/v1/integrations/tanta-pulse). Runs synchronously inside
 * the Stripe webhook handler — a purchase is not considered handled until
 * this call (or its retries) resolve, so no purchase can silently skip CRM
 * ingestion.
 *
 * Env:
 *   TANTA_PULSE_CRM_ADAPTER_URL     full adapter URL (never hardcoded)
 *   TANTA_PULSE_INGESTION_SECRET    HMAC-SHA256 signing secret, must match
 *                                   the value configured on the Atlas side
 */

import { createHash, createHmac } from "crypto";

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;

/**
 * Stable Pulse-side prospect identifier, derived from email so a checkout
 * customer maps to the same Atlas lead regardless of whether they were ever
 * seen by the Apify/Hunter prospect pipeline first.
 */
export function stableProspectId(email) {
  const normalized = email.trim().toLowerCase();
  const digest = createHash("sha256").update(`tanta_pulse:${normalized}`).digest("hex");
  return `pulse-prospect-${digest.slice(0, 32)}`;
}

/** RFC 4122 UUIDv5 (SHA-1, namespaced) — the CRM validates event_id as a UUID. */
function uuidV5(name, namespace) {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const digest = createHash("sha1").update(namespaceBytes).update(name, "utf8").digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

// Fixed namespace for deriving Pulse event IDs. Never change it: doing so
// re-mints every future event_id and breaks dedupe against events already
// delivered to the CRM.
const EVENT_ID_NAMESPACE = "3b7e9c1a-2f6d-4a8e-9b1c-6a5d8e2f0c17";

/**
 * Deterministic event_id for a logical business event. Stripe redelivers
 * checkout.session.completed on any non-2xx or timeout, so the ID must be
 * derived from the business key (the Stripe session/subscription id) rather
 * than minted fresh per delivery — otherwise a redelivery would insert a
 * second revenue row and double-count money.
 */
function deterministicEventId(keyParts) {
  return uuidV5(["tanta_pulse", ...keyParts].join("|"), EVENT_ID_NAMESPACE);
}

function signBody(rawBody, secret) {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function postSigned(url, secret, body) {
  const rawBody = JSON.stringify(body);
  const signature = signBody(rawBody, secret);
  let lastStatus;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tanta-signature": signature },
        body: rawBody,
      });
      lastStatus = response.status;
      if (response.ok) return { delivered: true, status: response.status, attempts: attempt };
      // 401/422 are permanent (signing or payload bug) — retrying won't help.
      if (response.status === 401 || response.status === 422) {
        return { delivered: false, reason: "permanent", status: response.status, attempts: attempt };
      }
      if (response.status < 500) {
        return { delivered: false, reason: "permanent", status: response.status, attempts: attempt };
      }
    } catch (err) {
      lastStatus = undefined;
      console.error(`[pulse-crm-sender] transport error on attempt ${attempt}:`, err);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
  }
  return { delivered: false, reason: "exhausted", status: lastStatus, attempts: MAX_ATTEMPTS };
}

/**
 * Records a checkout purchase in Atlas CRM as a verified prospect plus a
 * recorded conversion. The adapter requires lead.created before any later
 * event for the same person, so `prospect.verified` is always sent first —
 * this is safe to repeat: it dedupes by prospect_id on the CRM side.
 *
 * `sessionId` (the Stripe Checkout Session id) is the occurrence key for the
 * conversion event: a customer can subscribe more than once, so keying on
 * the session — not the lead — is what makes a second purchase a distinct
 * revenue row instead of colliding with the first.
 */
export async function recordPulseConversion({ email, name, tier, amountCents, currency, sessionId, occurredAt }) {
  const endpoint = process.env.TANTA_PULSE_CRM_ADAPTER_URL;
  const secret = process.env.TANTA_PULSE_INGESTION_SECRET;

  if (!endpoint || !secret) {
    console.warn("[pulse-crm-sender] TANTA_PULSE_CRM_ADAPTER_URL or TANTA_PULSE_INGESTION_SECRET not set — skipping CRM ingestion");
    return { delivered: false, reason: "not_configured" };
  }

  const prospectId = stableProspectId(email);
  const nowIso = occurredAt ?? new Date().toISOString();
  const [firstName, ...rest] = (name || "").trim().split(/\s+/).filter(Boolean);

  const verifiedEvent = {
    event_id: deterministicEventId(["prospect.verified", prospectId]),
    event_type: "prospect.verified",
    occurred_at: nowIso,
    prospect_id: prospectId,
    prospect: {
      email,
      ...(firstName ? { first_name: firstName } : {}),
      ...(rest.length ? { last_name: rest.join(" ") } : {}),
      source: "tantapulse_checkout",
      outreach_status: "pending",
    },
    lifecycle_stage: "customer",
  };

  const conversionEvent = {
    event_id: deterministicEventId(["prospect.conversion_recorded", sessionId]),
    event_type: "prospect.conversion_recorded",
    occurred_at: nowIso,
    prospect_id: prospectId,
    amount_cents: Math.round(amountCents),
    currency: (currency || "usd").toUpperCase(),
    revenue_type: `subscription_${tier}`,
    recognized_at: nowIso,
  };

  const verifiedResult = await postSigned(endpoint, secret, verifiedEvent);
  const conversionResult = await postSigned(endpoint, secret, conversionEvent);

  if (!verifiedResult.delivered) {
    console.error("[pulse-crm-sender] prospect.verified delivery failed:", verifiedResult);
  }
  if (!conversionResult.delivered) {
    console.error("[pulse-crm-sender] prospect.conversion_recorded delivery failed:", conversionResult);
  }

  return { verified: verifiedResult, conversion: conversionResult };
}

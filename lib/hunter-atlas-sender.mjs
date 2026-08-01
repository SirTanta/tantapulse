// Server-only sender for the Atlas ingestion contract.
//
// Boundaries enforced here, not by convention:
//   * Only the normalized envelopes below leave this process. Hunter API
//     responses, list exports and message bodies have no path into a payload.
//   * An open, a click or any other raw telemetry is never a confirmed fact.
//     Callers must present a confirmation reference from their own runtime.
//   * `prospect.verified` is delivered before any later lifecycle event for
//     that prospect, because Atlas rejects a non-create event for an unknown
//     lead.
//   * The endpoint and the signing secret are read from env by the caller and
//     never hardcoded, never shipped to a browser.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { evaluateProspectSend } from "./hunter-atlas-gate.mjs";

export const PROSPECT_SOURCE = "hunter";

export const EVENT_TYPES = Object.freeze({
  VERIFIED: "prospect.verified",
  STAGE_CHANGED: "prospect.stage_changed",
  CONVERSION: "prospect.conversion_recorded",
});

export const LIFECYCLE_STAGES = Object.freeze([
  "new",
  "contacted",
  "replied",
  "bounced",
  "opted_out",
  "meeting_booked",
]);

// Confirmed source fact -> Atlas outcome. Anything absent from this map is not
// reportable, which keeps derived telemetry out of the ledger by construction.
//
// `suppression_blocks` marks the facts that authorize or imply new outreach.
// Suppression is a send-side control, not a reporting control: it must not
// swallow the `opted_out` event that reports the suppression itself, nor the
// bounce/reply/revenue facts the runtime has already observed.
export const CONFIRMED_FACT_MAP = Object.freeze({
  verified_prospect_admitted: { event_type: EVENT_TYPES.VERIFIED, lifecycle_stage: "new", suppression_blocks: true },
  outreach_send_confirmed: { event_type: EVENT_TYPES.STAGE_CHANGED, lifecycle_stage: "contacted", suppression_blocks: true },
  outreach_reply_confirmed: { event_type: EVENT_TYPES.STAGE_CHANGED, lifecycle_stage: "replied", suppression_blocks: false },
  outreach_bounce_recorded: { event_type: EVENT_TYPES.STAGE_CHANGED, lifecycle_stage: "bounced", suppression_blocks: false },
  suppression_written: { event_type: EVENT_TYPES.STAGE_CHANGED, lifecycle_stage: "opted_out", suppression_blocks: false },
  meeting_confirmed: { event_type: EVENT_TYPES.STAGE_CHANGED, lifecycle_stage: "meeting_booked", suppression_blocks: false },
  revenue_confirmed: { event_type: EVENT_TYPES.CONVERSION, lifecycle_stage: null, suppression_blocks: false },
});

// Telemetry that is never, on its own, authorization to record a CRM outcome.
const UNCONFIRMED_SIGNALS = Object.freeze(["open", "opened", "click", "clicked", "impression", "view", "pixel"]);

const ENVELOPE_KEYS = Object.freeze({
  [EVENT_TYPES.VERIFIED]: ["event_id", "event_type", "occurred_at", "prospect_id", "lifecycle_stage", "prospect"],
  [EVENT_TYPES.STAGE_CHANGED]: ["event_id", "event_type", "occurred_at", "prospect_id", "lifecycle_stage", "reason"],
  [EVENT_TYPES.CONVERSION]: ["event_id", "event_type", "occurred_at", "prospect_id", "amount_cents", "currency", "revenue_type"],
});

const PROSPECT_KEYS = Object.freeze(["first_name", "last_name", "email", "source"]);

function isoUtc(value) {
  const parsed = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(parsed.getTime())) throw new Error("occurred_at must be a valid timestamp");
  return parsed.toISOString();
}

function text(value) {
  return String(value ?? "").trim();
}

export function buildOutcomeKey({ prospectId, factKind, outcomeRef = "primary" }) {
  const prospect = text(prospectId);
  const kind = text(factKind);
  if (!prospect || !kind) throw new Error("outcome key requires a prospect ID and a fact kind");
  if (prospect.includes(":")) throw new Error("prospect ID must not contain ':'");
  return `hunter:${prospect}:${kind}:${text(outcomeRef) || "primary"}`;
}

export function parseOutcomeKey(outcomeKey) {
  const [prefix, prospectId, factKind, ...rest] = String(outcomeKey ?? "").split(":");
  if (prefix !== "hunter" || !prospectId || !factKind || !rest.length) {
    throw new Error(`malformed outcome key: ${outcomeKey}`);
  }
  return { prospectId, factKind, outcomeRef: rest.join(":") };
}

// Rejects anything outside the contract before it can be signed or sent.
export function assertEnvelopeShape(event) {
  const allowed = ENVELOPE_KEYS[event?.event_type];
  if (!allowed) throw new Error(`unsupported event_type: ${event?.event_type}`);

  const actual = Object.keys(event);
  const unexpected = actual.filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`envelope contains non-contract fields: ${unexpected.join(", ")}`);
  const missing = allowed.filter((key) => event[key] === undefined);
  if (missing.length) throw new Error(`envelope is missing required fields: ${missing.join(", ")}`);

  if (event.event_type === EVENT_TYPES.VERIFIED) {
    const prospectKeys = Object.keys(event.prospect ?? {});
    const extra = prospectKeys.filter((key) => !PROSPECT_KEYS.includes(key));
    if (extra.length) throw new Error(`prospect object contains non-contract fields: ${extra.join(", ")}`);
    if (event.prospect.source !== PROSPECT_SOURCE) throw new Error("prospect.source must be 'hunter'");
  }
  if (event.lifecycle_stage !== undefined && event.lifecycle_stage !== null
    && !LIFECYCLE_STAGES.includes(event.lifecycle_stage)) {
    throw new Error(`unsupported lifecycle_stage: ${event.lifecycle_stage}`);
  }
  return event;
}

export function buildVerifiedEvent({ eventId, occurredAt, prospectId, prospect = {} }) {
  return assertEnvelopeShape({
    event_id: text(eventId),
    event_type: EVENT_TYPES.VERIFIED,
    occurred_at: isoUtc(occurredAt),
    prospect_id: text(prospectId),
    lifecycle_stage: "new",
    prospect: {
      first_name: text(prospect.first_name),
      last_name: text(prospect.last_name),
      email: text(prospect.email).toLowerCase(),
      source: PROSPECT_SOURCE,
    },
  });
}

export function buildStageChangedEvent({ eventId, occurredAt, prospectId, lifecycleStage, reason }) {
  return assertEnvelopeShape({
    event_id: text(eventId),
    event_type: EVENT_TYPES.STAGE_CHANGED,
    occurred_at: isoUtc(occurredAt),
    prospect_id: text(prospectId),
    lifecycle_stage: lifecycleStage,
    reason: text(reason),
  });
}

export function buildConversionEvent({ eventId, occurredAt, prospectId, amountCents, currency, revenueType }) {
  const amount = Number(amountCents);
  if (!Number.isInteger(amount)) throw new Error("amount_cents must be an integer");
  return assertEnvelopeShape({
    event_id: text(eventId),
    event_type: EVENT_TYPES.CONVERSION,
    occurred_at: isoUtc(occurredAt),
    prospect_id: text(prospectId),
    amount_cents: amount,
    currency: text(currency).toUpperCase(),
    revenue_type: text(revenueType),
  });
}

export function buildEventForFact({ factKind, eventId, occurredAt, prospectId, prospect, reason, revenue }) {
  const mapping = CONFIRMED_FACT_MAP[factKind];
  if (!mapping) throw new Error(`unmapped confirmed fact: ${factKind}`);

  if (mapping.event_type === EVENT_TYPES.VERIFIED) {
    return buildVerifiedEvent({ eventId, occurredAt, prospectId, prospect });
  }
  if (mapping.event_type === EVENT_TYPES.CONVERSION) {
    return buildConversionEvent({
      eventId,
      occurredAt,
      prospectId,
      amountCents: revenue?.amount_cents,
      currency: revenue?.currency,
      revenueType: revenue?.revenue_type,
    });
  }
  return buildStageChangedEvent({
    eventId,
    occurredAt,
    prospectId,
    lifecycleStage: mapping.lifecycle_stage,
    reason,
  });
}

// HMAC-SHA256 over the exact bytes that will be sent as the request body.
export function signBody(rawBody, secret) {
  if (!secret) throw new Error("HOLDINGS_INGESTION_SECRET is required to sign an Atlas payload");
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

export function signaturesMatch(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function classifyResponse(status) {
  if (status >= 200 && status < 300) return "delivered";
  if (status === 401 || status === 422) return "operator_review";
  if (status === 408 || status === 429 || status >= 500) return "retryable";
  return "rejected";
}

export function backoffDelayMs(attempt, baseDelayMs = 500) {
  return baseDelayMs * 2 ** Math.max(0, attempt - 1);
}

export async function postEvent({ endpoint, secret, event, fetchImpl = fetch }) {
  const rawBody = JSON.stringify(event);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tanta-Signature": signBody(rawBody, secret),
    },
    body: rawBody,
  });
  return { status: response.status, classification: classifyResponse(response.status) };
}

export async function deliverWithRetry({
  endpoint,
  secret,
  event,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxAttempts = 4,
  baseDelayMs = 500,
}) {
  let attempts = 0;
  let last = { status: 0, classification: "retryable" };

  while (attempts < maxAttempts) {
    attempts += 1;
    last = await postEvent({ endpoint, secret, event, fetchImpl });
    if (last.classification !== "retryable") break;
    if (attempts < maxAttempts) await sleepImpl(backoffDelayMs(attempts, baseDelayMs));
  }

  return { ...last, attempts };
}

function attemptStateFor(classification) {
  if (classification === "delivered") return "delivered";
  if (classification === "operator_review") return "operator_review";
  if (classification === "rejected") return "rejected";
  return "retry_scheduled";
}

// Strips a caller-supplied fact down to the contract fields before anything is
// persisted, so raw Hunter data cannot reach the ledger or a later retry.
export function normalizePayload(fact) {
  const mapping = CONFIRMED_FACT_MAP[fact?.kind];
  if (!mapping) throw new Error(`unmapped confirmed fact: ${fact?.kind}`);

  if (mapping.event_type === EVENT_TYPES.VERIFIED) {
    return {
      prospect: {
        first_name: text(fact.prospect?.first_name),
        last_name: text(fact.prospect?.last_name),
        email: text(fact.prospect?.email).toLowerCase(),
        source: PROSPECT_SOURCE,
      },
    };
  }
  if (mapping.event_type === EVENT_TYPES.CONVERSION) {
    return {
      revenue: {
        amount_cents: Number(fact.revenue?.amount_cents),
        currency: text(fact.revenue?.currency).toUpperCase(),
        revenue_type: text(fact.revenue?.revenue_type),
      },
    };
  }
  return { reason: text(fact.reason) };
}

function assertConfirmedFact(fact) {
  if (!CONFIRMED_FACT_MAP[fact?.kind]) throw new Error(`unmapped confirmed fact: ${fact?.kind}`);
  const confirmedBy = text(fact.confirmed_by);
  if (!confirmedBy) throw new Error("a confirmed fact requires a confirmation reference from the Pulse runtime");
  if (UNCONFIRMED_SIGNALS.includes(confirmedBy.toLowerCase())) {
    throw new Error(`raw telemetry (${confirmedBy}) is never a confirmed fact`);
  }
}

// The single write path to Atlas. Returns a receipt; never throws for a
// blocked prospect, because "blocked" is a normal, expected outcome.
export async function deliverConfirmedFact({
  fact,
  store,
  endpoint,
  secret,
  fetchImpl = fetch,
  sleepImpl,
  now = new Date(),
  maxAttempts = 4,
  baseDelayMs = 500,
}) {
  if (!endpoint || !secret) {
    return { sent: false, blocked: true, reason: "sender_misconfigured", event_id: null };
  }
  assertConfirmedFact(fact);

  const mapping = CONFIRMED_FACT_MAP[fact.kind];
  const prospectId = text(fact.prospect_id);
  const isAdmission = mapping.event_type === EVENT_TYPES.VERIFIED;

  // Suppression is read on every path, ahead of the approval, so that resuming
  // an approval can never resurrect a suppressed prospect.
  const suppression = await store.getSuppression(prospectId);
  if (suppression && mapping.suppression_blocks) {
    return { sent: false, blocked: true, reason: "suppressed", event_id: null };
  }

  if (isAdmission) {
    const prospect = await store.getProspect(prospectId);
    const approval = prospect ? await store.getApproval(prospect.approval_id) : null;
    const [sentCount, metrics] = approval
      ? await Promise.all([store.countDeliveredSends(approval.approval_id), store.getApprovalMetrics(approval.approval_id)])
      : [0, {}];
    const gate = evaluateProspectSend({ approval, prospect, suppression: null, now, sentCount, metrics });
    if (!gate.allowed) return { sent: false, blocked: true, reason: gate.reason, event_id: null };
  } else if (!(await store.hasDeliveredCreate(prospectId))) {
    // Atlas rejects a non-create event for a lead it has never seen.
    return { sent: false, blocked: true, reason: "create_event_not_delivered", event_id: null };
  }

  const outcomeKey = buildOutcomeKey({ prospectId, factKind: fact.kind, outcomeRef: fact.outcome_ref });
  const claim = await store.claimDelivery({
    outcomeKey,
    prospectId,
    approvalId: fact.approval_id ?? null,
    eventType: mapping.event_type,
    lifecycleStage: mapping.lifecycle_stage,
    occurredAt: isoUtc(fact.occurred_at ?? now),
    normalizedPayload: normalizePayload(fact),
  });

  if (claim.attempt_state === "delivered") {
    return { sent: false, duplicate: true, reason: "already_delivered", event_id: claim.event_id, outcome_key: outcomeKey };
  }

  // The first claim's stored payload and timestamp win, so a retry reproduces
  // byte-identical bytes under the same event_id and the same signature.
  const payload = claim.normalized_payload ?? normalizePayload(fact);
  const event = buildEventForFact({
    factKind: fact.kind,
    eventId: claim.event_id,
    occurredAt: claim.occurred_at,
    prospectId,
    prospect: payload.prospect,
    reason: payload.reason,
    revenue: payload.revenue,
  });

  const result = await deliverWithRetry({ endpoint, secret, event, fetchImpl, sleepImpl, maxAttempts, baseDelayMs });
  const attemptState = attemptStateFor(result.classification);

  await store.recordDeliveryOutcome({
    outcomeKey,
    eventId: claim.event_id,
    attemptState,
    responseStatus: result.status,
    classification: result.classification,
    attempts: (Number(claim.attempts) || 0) + result.attempts,
  });

  if (result.classification === "operator_review") {
    throw new Error(`Atlas rejected ${event.event_type} for operator review (status ${result.status})`);
  }

  return {
    sent: result.classification === "delivered",
    duplicate: Boolean(claim.duplicate),
    event_id: claim.event_id,
    outcome_key: outcomeKey,
    event_type: event.event_type,
    lifecycle_stage: mapping.lifecycle_stage,
    status: result.status,
    classification: result.classification,
    attempts: result.attempts,
  };
}

export function newEventId() {
  return randomUUID();
}

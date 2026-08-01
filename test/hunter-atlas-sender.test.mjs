import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomUUID } from "node:crypto";

import {
  CONFIRMED_FACT_MAP,
  assertEnvelopeShape,
  backoffDelayMs,
  buildConversionEvent,
  buildOutcomeKey,
  buildStageChangedEvent,
  buildVerifiedEvent,
  classifyResponse,
  deliverConfirmedFact,
  normalizePayload,
  parseOutcomeKey,
  signBody,
} from "../lib/hunter-atlas-sender.mjs";
import handler, { factFromLedgerRow } from "../api/hunter/atlas-sync.js";

const ENDPOINT = "https://crm.invalid/api/v1/integrations/tanta-pulse";
const SECRET = "test-ingestion-secret";
const NOW = new Date("2026-08-04T12:00:00Z");

function approvalFixture(overrides = {}) {
  return {
    approval_id: "apr_001",
    hunter_list_id: "list_77",
    authorized_owner: "owner@tantaholdings.com",
    audience_description: "Austin roofing operators",
    legal_basis: "legitimate_interest",
    offer_version: "offer_v3",
    message_version: "msg_v2",
    run_starts_at: "2026-08-01T00:00:00Z",
    run_ends_at: "2026-08-08T00:00:00Z",
    send_cap: 100,
    stop_conditions: {},
    state: "approved",
    ...overrides,
  };
}

function prospectFixture(overrides = {}) {
  return {
    prospect_id: "hp_1001",
    hunter_list_id: "list_77",
    approval_id: "apr_001",
    verification_state: "verified",
    enrollment_state: "enrolled",
    suppression_decision: "allowed",
    ...overrides,
  };
}

function fakeStore({ approval = approvalFixture(), prospect = prospectFixture(), suppression = null, sentCount = 0, metrics = {}, createDelivered = false } = {}) {
  const ledger = new Map();
  return {
    ledger,
    async getSuppression() { return suppression; },
    async getProspect() { return prospect; },
    async getApproval() { return approval; },
    async countDeliveredSends() { return sentCount; },
    async getApprovalMetrics() { return metrics; },
    async hasDeliveredCreate() { return createDelivered; },
    async claimDelivery({ outcomeKey, prospectId, approvalId, eventType, lifecycleStage, occurredAt, normalizedPayload }) {
      const existing = ledger.get(outcomeKey);
      if (existing) return { ...existing, duplicate: true };
      const row = {
        outcome_key: outcomeKey,
        event_id: randomUUID(),
        prospect_id: prospectId,
        approval_id: approvalId,
        event_type: eventType,
        lifecycle_stage: lifecycleStage,
        occurred_at: occurredAt,
        normalized_payload: normalizedPayload,
        attempt_state: "pending",
        attempts: 0,
      };
      ledger.set(outcomeKey, row);
      return row;
    },
    async recordDeliveryOutcome({ outcomeKey, attemptState, responseStatus, classification, attempts }) {
      Object.assign(ledger.get(outcomeKey), {
        attempt_state: attemptState,
        response_status: responseStatus,
        response_classification: classification,
        attempts,
      });
    },
  };
}

function recordingFetch(statuses) {
  const calls = [];
  const queue = [...statuses];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const status = queue.length > 1 ? queue.shift() : queue[0];
    return new Response(JSON.stringify({ ok: status < 300 }), { status });
  };
  return { fetchImpl, calls };
}

function verifiedFact(overrides = {}) {
  return {
    kind: "verified_prospect_admitted",
    prospect_id: "hp_1001",
    approval_id: "apr_001",
    occurred_at: NOW.toISOString(),
    outcome_ref: "run_2026_08_04",
    confirmed_by: "hunter_verification_job:4471",
    prospect: { first_name: "Dana", last_name: "Reyes", email: "Dana@Example.com" },
    ...overrides,
  };
}

// --- signature ------------------------------------------------------------

test("the signature is an HMAC-SHA256 hex digest of the raw body under the shared secret", () => {
  const body = JSON.stringify({ event_id: "e1", event_type: "prospect.verified" });
  const expected = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
  assert.equal(signBody(body, SECRET), `sha256=${expected}`);
  assert.match(signBody(body, SECRET), /^sha256=[0-9a-f]{64}$/);
});

test("the signature changes with the body and with the secret, and refuses to sign without one", () => {
  const body = JSON.stringify({ event_id: "e1" });
  assert.notEqual(signBody(body, SECRET), signBody(JSON.stringify({ event_id: "e2" }), SECRET));
  assert.notEqual(signBody(body, SECRET), signBody(body, "another-secret"));
  assert.throws(() => signBody(body, ""), /HOLDINGS_INGESTION_SECRET/);
});

test("the transmitted signature verifies against the exact bytes that were sent", async () => {
  const { fetchImpl, calls } = recordingFetch([200]);
  const store = fakeStore();
  await deliverConfirmedFact({ fact: verifiedFact(), store, endpoint: ENDPOINT, secret: SECRET, fetchImpl, now: NOW });

  const { options } = calls[0];
  assert.equal(options.headers["Content-Type"], "application/json");
  const recomputed = createHmac("sha256", SECRET).update(options.body, "utf8").digest("hex");
  assert.equal(options.headers["X-Tanta-Signature"], `sha256=${recomputed}`);
});

// --- envelope contract ----------------------------------------------------

test("the verified envelope carries exactly the contract fields and hunter as source", () => {
  const event = buildVerifiedEvent({ eventId: "e1", occurredAt: NOW, prospectId: "hp_1001", prospect: { first_name: "Dana", last_name: "Reyes", email: "Dana@Example.com" } });
  assert.deepEqual(event, {
    event_id: "e1",
    event_type: "prospect.verified",
    occurred_at: "2026-08-04T12:00:00.000Z",
    prospect_id: "hp_1001",
    lifecycle_stage: "new",
    prospect: { first_name: "Dana", last_name: "Reyes", email: "dana@example.com", source: "hunter" },
  });
});

test("the stage-change and conversion envelopes match the contract shapes", () => {
  assert.deepEqual(buildStageChangedEvent({ eventId: "e2", occurredAt: NOW, prospectId: "hp_1001", lifecycleStage: "contacted", reason: "approved outreach sent" }), {
    event_id: "e2",
    event_type: "prospect.stage_changed",
    occurred_at: "2026-08-04T12:00:00.000Z",
    prospect_id: "hp_1001",
    lifecycle_stage: "contacted",
    reason: "approved outreach sent",
  });
  assert.deepEqual(buildConversionEvent({ eventId: "e3", occurredAt: NOW, prospectId: "hp_1001", amountCents: 49900, currency: "usd", revenueType: "subscription" }), {
    event_id: "e3",
    event_type: "prospect.conversion_recorded",
    occurred_at: "2026-08-04T12:00:00.000Z",
    prospect_id: "hp_1001",
    amount_cents: 49900,
    currency: "USD",
    revenue_type: "subscription",
  });
});

test("the confirmed-fact map matches the authoritative event table", () => {
  const stages = Object.fromEntries(Object.entries(CONFIRMED_FACT_MAP).map(([kind, value]) => [kind, [value.event_type, value.lifecycle_stage]]));
  assert.deepEqual(stages, {
    verified_prospect_admitted: ["prospect.verified", "new"],
    outreach_send_confirmed: ["prospect.stage_changed", "contacted"],
    outreach_reply_confirmed: ["prospect.stage_changed", "replied"],
    outreach_bounce_recorded: ["prospect.stage_changed", "bounced"],
    suppression_written: ["prospect.stage_changed", "opted_out"],
    meeting_confirmed: ["prospect.stage_changed", "meeting_booked"],
    revenue_confirmed: ["prospect.conversion_recorded", null],
  });
});

test("raw Hunter data cannot reach a payload", () => {
  assert.throws(
    () => assertEnvelopeShape({ event_id: "e1", event_type: "prospect.verified", occurred_at: NOW.toISOString(), prospect_id: "hp_1001", lifecycle_stage: "new", prospect: { first_name: "D", last_name: "R", email: "d@e.com", source: "hunter" }, hunter_raw: { position: "Owner" } }),
    /non-contract fields: hunter_raw/,
  );
  assert.throws(
    () => assertEnvelopeShape({ event_id: "e1", event_type: "prospect.verified", occurred_at: NOW.toISOString(), prospect_id: "hp_1001", lifecycle_stage: "new", prospect: { first_name: "D", last_name: "R", email: "d@e.com", source: "hunter", confidence: 97 } }),
    /prospect object contains non-contract fields: confidence/,
  );
  assert.throws(() => assertEnvelopeShape({ event_id: "e1", event_type: "prospect.enriched" }), /unsupported event_type/);

  const normalized = normalizePayload({ kind: "verified_prospect_admitted", prospect: { first_name: "Dana", last_name: "Reyes", email: "d@e.com", confidence: 97, hunter_raw: { x: 1 } } });
  assert.deepEqual(Object.keys(normalized.prospect), ["first_name", "last_name", "email", "source"]);
});

test("only mapped facts backed by a runtime confirmation are deliverable", async () => {
  const store = fakeStore();
  const { fetchImpl, calls } = recordingFetch([200]);
  const args = { store, endpoint: ENDPOINT, secret: SECRET, fetchImpl, now: NOW };

  await assert.rejects(deliverConfirmedFact({ fact: verifiedFact({ kind: "email_opened" }), ...args }), /unmapped confirmed fact/);
  await assert.rejects(deliverConfirmedFact({ fact: verifiedFact({ confirmed_by: "" }), ...args }), /confirmation reference/);
  await assert.rejects(deliverConfirmedFact({ fact: verifiedFact({ confirmed_by: "click" }), ...args }), /raw telemetry \(click\) is never a confirmed fact/);
  await assert.rejects(deliverConfirmedFact({ fact: verifiedFact({ confirmed_by: "Opened" }), ...args }), /raw telemetry/);
  assert.equal(calls.length, 0);
});

// --- gating ---------------------------------------------------------------

test("every blocking approval state stops the delivery before any network call", async () => {
  for (const [state, reason] of [["paused", "approval_paused"], ["stopped", "approval_stopped"], ["expired", "approval_expired"]]) {
    const { fetchImpl, calls } = recordingFetch([200]);
    const store = fakeStore({ approval: approvalFixture({ state }) });
    const result = await deliverConfirmedFact({ fact: verifiedFact(), store, endpoint: ENDPOINT, secret: SECRET, fetchImpl, now: NOW });
    assert.deepEqual(result, { sent: false, blocked: true, reason, event_id: null });
    assert.equal(calls.length, 0, `${state} must not reach the network`);
    assert.equal(store.ledger.size, 0, `${state} must not claim a ledger row`);
  }
});

test("an absent approval and an over-cap approval both fail closed", async () => {
  const { fetchImpl, calls } = recordingFetch([200]);
  const absent = await deliverConfirmedFact({ fact: verifiedFact(), store: fakeStore({ approval: null }), endpoint: ENDPOINT, secret: SECRET, fetchImpl, now: NOW });
  assert.equal(absent.reason, "approval_absent");

  const overCap = await deliverConfirmedFact({ fact: verifiedFact(), store: fakeStore({ approval: approvalFixture({ send_cap: 10 }), sentCount: 10 }), endpoint: ENDPOINT, secret: SECRET, fetchImpl, now: NOW });
  assert.equal(overCap.reason, "approval_cap_reached");

  const stopped = await deliverConfirmedFact({ fact: verifiedFact(), store: fakeStore({ approval: approvalFixture({ stop_conditions: { bounced: 3 } }), metrics: { bounced: 3 } }), endpoint: ENDPOINT, secret: SECRET, fetchImpl, now: NOW });
  assert.equal(stopped.reason, "stop_condition:bounced");

  assert.equal(calls.length, 0);
});

test("a suppression blocks admission and outreach, but never the report that records it", async () => {
  const suppression = { prospect_id: "hp_1001", reason: "opt_out" };

  for (const kind of ["verified_prospect_admitted", "outreach_send_confirmed"]) {
    const { fetchImpl, calls } = recordingFetch([200]);
    const store = fakeStore({ suppression, createDelivered: true });
    const result = await deliverConfirmedFact({ fact: verifiedFact({ kind, reason: "x" }), store, endpoint: ENDPOINT, secret: SECRET, fetchImpl, now: NOW });
    assert.deepEqual(result, { sent: false, blocked: true, reason: "suppressed", event_id: null });
    assert.equal(calls.length, 0, `${kind} must not reach the network`);
  }

  const { fetchImpl, calls } = recordingFetch([200]);
  const store = fakeStore({ suppression, createDelivered: true });
  const optOut = await deliverConfirmedFact({
    fact: verifiedFact({ kind: "suppression_written", reason: "opt-out honoured", prospect: undefined }),
    store, endpoint: ENDPOINT, secret: SECRET, fetchImpl, now: NOW,
  });
  assert.equal(optOut.sent, true);
  assert.equal(optOut.lifecycle_stage, "opted_out");
  assert.equal(JSON.parse(calls[0].options.body).lifecycle_stage, "opted_out");
});

test("a later lifecycle event is withheld until the create event has been delivered", async () => {
  const { fetchImpl, calls } = recordingFetch([200]);
  const store = fakeStore({ createDelivered: false });
  const result = await deliverConfirmedFact({
    fact: verifiedFact({ kind: "outreach_send_confirmed", reason: "approved outreach sent", prospect: undefined }),
    store, endpoint: ENDPOINT, secret: SECRET, fetchImpl, now: NOW,
  });
  assert.deepEqual(result, { sent: false, blocked: true, reason: "create_event_not_delivered", event_id: null });
  assert.equal(calls.length, 0);
  assert.equal(store.ledger.size, 0);
});

test("a missing endpoint or secret fails closed before anything is signed or claimed", async () => {
  const { fetchImpl, calls } = recordingFetch([200]);
  const store = fakeStore();
  for (const args of [{ endpoint: "", secret: SECRET }, { endpoint: ENDPOINT, secret: "" }]) {
    const result = await deliverConfirmedFact({ fact: verifiedFact(), store, fetchImpl, now: NOW, ...args });
    assert.deepEqual(result, { sent: false, blocked: true, reason: "sender_misconfigured", event_id: null });
  }
  assert.equal(calls.length, 0);
  assert.equal(store.ledger.size, 0);
});

// --- idempotency ----------------------------------------------------------

test("outcome keys are stable per confirmed fact and round-trip through the ledger", () => {
  const key = buildOutcomeKey({ prospectId: "hp_1001", factKind: "outreach_send_confirmed", outcomeRef: "run_2026_08_04" });
  assert.equal(key, "hunter:hp_1001:outreach_send_confirmed:run_2026_08_04");
  assert.equal(buildOutcomeKey({ prospectId: "hp_1001", factKind: "outreach_send_confirmed" }), "hunter:hp_1001:outreach_send_confirmed:primary");
  assert.deepEqual(parseOutcomeKey(key), { prospectId: "hp_1001", factKind: "outreach_send_confirmed", outcomeRef: "run_2026_08_04" });
  assert.throws(() => parseOutcomeKey("nope"), /malformed outcome key/);
});

test("redelivering the same confirmed fact is a no-op that reuses the original event_id", async () => {
  const { fetchImpl, calls } = recordingFetch([200]);
  const store = fakeStore();
  const args = { fact: verifiedFact(), store, endpoint: ENDPOINT, secret: SECRET, fetchImpl, now: NOW };

  const first = await deliverConfirmedFact(args);
  const second = await deliverConfirmedFact(args);

  assert.equal(first.sent, true);
  assert.equal(second.sent, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.reason, "already_delivered");
  assert.equal(second.event_id, first.event_id);
  assert.equal(calls.length, 1, "a delivered fact must not be posted twice");
  assert.equal(store.ledger.size, 1);
});

test("a retry after a failure reuses the original event_id, timestamp and signature", async () => {
  const store = fakeStore();
  const failing = recordingFetch([503, 503, 503, 503]);
  const args = { fact: verifiedFact(), store, endpoint: ENDPOINT, secret: SECRET, now: NOW, sleepImpl: async () => {}, maxAttempts: 1 };

  const first = await deliverConfirmedFact({ ...args, fetchImpl: failing.fetchImpl });
  assert.equal(first.sent, false);
  assert.equal(first.classification, "retryable");
  assert.equal(store.ledger.get(first.outcome_key).attempt_state, "retry_scheduled");

  const succeeding = recordingFetch([200]);
  const second = await deliverConfirmedFact({ ...args, fetchImpl: succeeding.fetchImpl });
  assert.equal(second.sent, true);
  assert.equal(second.event_id, first.event_id);
  assert.equal(failing.calls[0].options.body, succeeding.calls[0].options.body);
  assert.equal(failing.calls[0].options.headers["X-Tanta-Signature"], succeeding.calls[0].options.headers["X-Tanta-Signature"]);
});

test("distinct confirmed facts for one prospect get distinct event_ids", async () => {
  const { fetchImpl } = recordingFetch([200]);
  const store = fakeStore({ createDelivered: true });
  const base = { store, endpoint: ENDPOINT, secret: SECRET, fetchImpl, now: NOW };

  const created = await deliverConfirmedFact({ fact: verifiedFact(), ...base });
  const contacted = await deliverConfirmedFact({ fact: verifiedFact({ kind: "outreach_send_confirmed", reason: "approved outreach sent", prospect: undefined }), ...base });

  assert.notEqual(created.event_id, contacted.event_id);
  assert.equal(store.ledger.size, 2);
});

// --- response handling ----------------------------------------------------

test("responses are classified per the retry contract", () => {
  assert.equal(classifyResponse(200), "delivered");
  assert.equal(classifyResponse(202), "delivered");
  assert.equal(classifyResponse(401), "operator_review");
  assert.equal(classifyResponse(422), "operator_review");
  assert.equal(classifyResponse(429), "retryable");
  assert.equal(classifyResponse(500), "retryable");
  assert.equal(classifyResponse(503), "retryable");
  assert.equal(classifyResponse(400), "rejected");
  assert.equal(classifyResponse(404), "rejected");
});

test("5xx responses retry with exponential backoff and stop at the attempt ceiling", async () => {
  const delays = [];
  const { fetchImpl, calls } = recordingFetch([500]);
  const store = fakeStore();
  const result = await deliverConfirmedFact({
    fact: verifiedFact(), store, endpoint: ENDPOINT, secret: SECRET, fetchImpl, now: NOW,
    sleepImpl: async (ms) => { delays.push(ms); }, maxAttempts: 4, baseDelayMs: 500,
  });

  assert.equal(result.sent, false);
  assert.equal(result.attempts, 4);
  assert.equal(calls.length, 4);
  assert.deepEqual(delays, [500, 1000, 2000]);
  assert.deepEqual([1, 2, 3].map((n) => backoffDelayMs(n, 500)), [500, 1000, 2000]);
  assert.equal(store.ledger.get(result.outcome_key).attempt_state, "retry_scheduled");
});

test("a 5xx followed by a 2xx succeeds without exhausting the attempt budget", async () => {
  const { fetchImpl, calls } = recordingFetch([503, 200]);
  const store = fakeStore();
  const result = await deliverConfirmedFact({ fact: verifiedFact(), store, endpoint: ENDPOINT, secret: SECRET, fetchImpl, now: NOW, sleepImpl: async () => {} });
  assert.equal(result.sent, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls.length, 2);
});

test("401 and 422 fail the run for operator review without a blind retry", async () => {
  for (const status of [401, 422]) {
    const { fetchImpl, calls } = recordingFetch([status]);
    const store = fakeStore();
    await assert.rejects(
      deliverConfirmedFact({ fact: verifiedFact(), store, endpoint: ENDPOINT, secret: SECRET, fetchImpl, now: NOW, sleepImpl: async () => {} }),
      new RegExp(`operator review \\(status ${status}\\)`),
    );
    assert.equal(calls.length, 1, `${status} must not be retried`);
    assert.equal([...store.ledger.values()][0].attempt_state, "operator_review");
  }
});

// --- handler --------------------------------------------------------------

test("the sync endpoint rejects an unauthorized scheduler call before any request", async () => {
  const originalFetch = global.fetch;
  const originalSecret = process.env.CRON_SECRET;
  let requests = 0;
  global.fetch = async () => { requests += 1; throw new Error("must not be called"); };
  process.env.CRON_SECRET = "test-cron-secret";
  const res = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, setHeader() {} };

  try {
    await handler({ method: "GET", headers: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "Unauthorized" });
    await handler({ method: "POST", headers: { authorization: "Bearer test-cron-secret" } }, res);
    assert.equal(res.statusCode, 405);
    assert.equal(requests, 0);
  } finally {
    global.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});

test("the sync endpoint refuses to run until the Atlas endpoint and secret are configured", async () => {
  const originalFetch = global.fetch;
  const saved = { CRON_SECRET: process.env.CRON_SECRET, CRM_INGESTION_ENDPOINT: process.env.CRM_INGESTION_ENDPOINT, HOLDINGS_INGESTION_SECRET: process.env.HOLDINGS_INGESTION_SECRET };
  let requests = 0;
  global.fetch = async () => { requests += 1; throw new Error("must not be called"); };
  process.env.CRON_SECRET = "test-cron-secret";
  delete process.env.CRM_INGESTION_ENDPOINT;
  delete process.env.HOLDINGS_INGESTION_SECRET;
  const res = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, setHeader() {} };

  try {
    await handler({ method: "GET", headers: { authorization: "Bearer test-cron-secret" } }, res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: "Atlas ingestion sender is not configured" });
    assert.equal(requests, 0);
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a ledger row rebuilds the confirmed fact it was written from", () => {
  const fact = factFromLedgerRow({
    outcome_key: "hunter:hp_1001:outreach_send_confirmed:run_2026_08_04",
    prospect_id: "hp_1001",
    approval_id: "apr_001",
    occurred_at: "2026-08-04T12:00:00.000Z",
    normalized_payload: { reason: "approved outreach sent" },
  });
  assert.equal(fact.kind, "outreach_send_confirmed");
  assert.equal(fact.outcome_ref, "run_2026_08_04");
  assert.equal(fact.reason, "approved outreach sent");
  assert.equal(fact.confirmed_by, "ledger:hunter:hp_1001:outreach_send_confirmed:run_2026_08_04");
});

test("no Hunter, outreach, Apify, Resend or Stripe endpoint is contacted by the sender", async () => {
  const { fetchImpl, calls } = recordingFetch([200]);
  const store = fakeStore({ createDelivered: true });
  await deliverConfirmedFact({ fact: verifiedFact(), store, endpoint: ENDPOINT, secret: SECRET, fetchImpl, now: NOW });
  await deliverConfirmedFact({ fact: verifiedFact({ kind: "meeting_confirmed", reason: "meeting booked", outcome_ref: "mtg_1", prospect: undefined }), store, endpoint: ENDPOINT, secret: SECRET, fetchImpl, now: NOW });

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.url, ENDPOINT);
    assert.doesNotMatch(call.url, /hunter\.io|apify|resend|stripe|sendgrid/i);
  }
});

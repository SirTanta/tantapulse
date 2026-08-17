import assert from "node:assert/strict";
import test from "node:test";

import { campaignGate, hmacSignature, listHunterMessages, makeNoSendReceipt, normalizeHunterMessage, normalizeProspect, postAtlasEvent, recipientEnrollmentGate, stableUuid, toSakuyaFollowUpEvent, verificationGate, verifyHunterEmail } from "../lib/outbound-lifecycle.mjs";
import noSendHandler from "../api/outbound/no-send.js";
import reconcileHandler from "../api/outbound/reconcile.js";
import legacySendHandler from "../api/lead-feed/send.js";
import salesDiscoveryTriggerHandler from "../api/sales-discovery/trigger.js";
import lane2TriggerHandler from "../api/lane2/trigger.js";
import enrollHandler from "../api/outbound/enroll.js";
import sourceHandler from "../api/outbound/source.js";
import preflightHandler from "../api/outbound/preflight.js";

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader() {},
  };
}

test("live automation fails closed without every release gate", () => {
  const result = campaignGate({ mode: "disabled" });
  assert.equal(result.allowed, false);
  assert.ok(result.missing.includes("TANTAPULSE_OUTBOUND_MODE=live"));
  assert.ok(result.missing.includes("approved Atlas campaign record"));
});

test("campaign gate rejects a prospect plan that would exceed its approved variable-cost cap", () => {
  const result = campaignGate({
    mode: "live", liveReleaseApproved: true, campaignId: "tp-test", approvalId: "approval-1", sequenceId: "sequence-1", senderAccountId: "sender-1", listId: "list-1", hunterApiKey: "hunter-key", atlasEndpoint: "https://atlas.test", ingestionSecret: "secret",
    approval: { status: "approved", campaign_id: "tp-test", sequence_id: "sequence-1", sender_account_id: "sender-1", approved_list_id: "list-1", prospect_cap: 5, variable_cost_cap_cents: 40, estimated_variable_cost_per_prospect_cents: 10 },
  });
  assert.equal(result.allowed, false);
  assert.ok(result.missing.includes("prospect cap within approved variable-cost cap"));
});

test("Hunter recipient enrollment requires a separate explicit approval", () => {
  const config = {
    mode: "live", liveReleaseApproved: true, campaignId: "tp-test", approvalId: "approval-1", sequenceId: "sequence-1", senderAccountId: "sender-1", listId: "list-1", hunterApiKey: "hunter-key", atlasEndpoint: "https://atlas.test", ingestionSecret: "secret",
    approval: { status: "approved", campaign_id: "tp-test", sequence_id: "sequence-1", sender_account_id: "sender-1", approved_list_id: "list-1", prospect_cap: 5, variable_cost_cap_cents: 50, estimated_variable_cost_per_prospect_cents: 10, recipient_enrollment_approved: false },
  };
  const result = recipientEnrollmentGate(config);
  assert.equal(result.allowed, false);
  assert.ok(result.missing.includes("TANTAPULSE_HUNTER_RECIPIENT_ENROLLMENT_APPROVED=true"));
  assert.ok(result.missing.includes("approved Atlas recipient enrollment"));
});

test("Apify-to-Hunter verification requires an exact approved source run and cap", () => {
  const config = {
    mode: "live", liveReleaseApproved: true, verificationApproved: true, sourceFilterKey: "local-seo-v1", sourceRunId: "run-1", campaignId: "tp-test", approvalId: "approval-1", sequenceId: "sequence-1", senderAccountId: "sender-1", listId: "list-1", hunterApiKey: "hunter-key", atlasEndpoint: "https://atlas.test", ingestionSecret: "secret",
    approval: { status: "approved", campaign_id: "tp-test", sequence_id: "sequence-1", sender_account_id: "sender-1", approved_list_id: "list-1", prospect_cap: 5, variable_cost_cap_cents: 50, estimated_variable_cost_per_prospect_cents: 10, verification_approved: true, verification_cap: 5, source_filter_key: "local-seo-v1", source_run_id: "run-1" },
  };
  assert.equal(verificationGate(config).allowed, true);
  assert.equal(verificationGate({ ...config, sourceRunId: "run-2" }).allowed, false);
});

test("no-send fixtures emit sanitized lifecycle plans without calling a provider", () => {
  const receipt = makeNoSendReceipt({ campaignId: "tp-test", fixtures: [
    { kind: "prospect", id: "lead-1", email: "avery@example.com", verification: "valid" },
    { id: "message-1", lead: { id: "lead-1" }, status: "replied", subject: "private", body: "private reply" },
  ] });
  assert.equal(receipt.mode, "no_send");
  assert.equal(receipt.planned_event_count, 3);
  assert.deepEqual(receipt.events.map((event) => event.event_type), ["prospect.verified", "prospect.stage_changed", "prospect.follow_up_scheduled"]);
  assert.equal(JSON.stringify(receipt).includes("private"), false);
});

test("only a meaningful reply creates an idempotent Sakuya task with no message content", () => {
  const reply = normalizeHunterMessage({ id: "m-2", lead: { id: "lead-2" }, status: "replied", body: "sensitive reply" });
  const task = toSakuyaFollowUpEvent(reply);
  assert.equal(task.event.event_type, "prospect.follow_up_scheduled");
  assert.equal(task.event.task.task_key, "tantapulse:reply:m-2");
  assert.equal(JSON.stringify(task).includes("sensitive reply"), false);
  assert.equal(toSakuyaFollowUpEvent(normalizeHunterMessage({ id: "m-3", lead: { id: "lead-3" }, status: "bounced" })), null);
});

test("no-send endpoint has no provider or Atlas fetch path", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousFetch = global.fetch;
  process.env.CRON_SECRET = "test-cron-secret";
  global.fetch = async () => { throw new Error("no-send endpoint must not fetch"); };
  const response = responseRecorder();
  try {
    await noSendHandler({ method: "POST", headers: { authorization: "Bearer test-cron-secret" }, body: { campaign_id: "tp-test", fixtures: [{ kind: "prospect", id: "lead-1", email: "a@example.com", verification: "valid" }] } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.receipt.mode, "no_send");
  } finally {
    global.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  }
});

test("reconciliation rejects an untrusted call before any provider read", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousFetch = global.fetch;
  process.env.CRON_SECRET = "test-cron-secret";
  global.fetch = async () => { throw new Error("untrusted reconciliation must not fetch"); };
  const response = responseRecorder();
  try {
    await reconcileHandler({ method: "GET", headers: {} }, response);
    assert.equal(response.statusCode, 401);
  } finally {
    global.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  }
});

test("recipient enrollment rejects an untrusted call before any provider read", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousFetch = global.fetch;
  process.env.CRON_SECRET = "test-cron-secret";
  global.fetch = async () => { throw new Error("untrusted enrollment must not fetch"); };
  const response = responseRecorder();
  try {
    await enrollHandler({ method: "GET", headers: {} }, response);
    assert.equal(response.statusCode, 401);
  } finally {
    global.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  }
});

test("source verification rejects an untrusted call before any source or provider read", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousFetch = global.fetch;
  process.env.CRON_SECRET = "test-cron-secret";
  global.fetch = async () => { throw new Error("untrusted source verification must not fetch"); };
  const response = responseRecorder();
  try {
    await sourceHandler({ method: "GET", headers: {} }, response);
    assert.equal(response.statusCode, 401);
  } finally {
    global.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  }
});

test("preflight rejects an untrusted call before any state or provider read", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousFetch = global.fetch;
  process.env.CRON_SECRET = "test-cron-secret";
  global.fetch = async () => { throw new Error("untrusted preflight must not fetch"); };
  const response = responseRecorder();
  try {
    await preflightHandler({ method: "GET", headers: {} }, response);
    assert.equal(response.statusCode, 401);
  } finally {
    global.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  }
});

test("legacy Resend sender is disabled before any provider read", async () => {
  const previousFetch = global.fetch;
  const previousEnabled = process.env.TANTAPULSE_LEGACY_RESEND_SEND_ENABLED;
  const previousRelease = process.env.TANTAPULSE_LIVE_RELEASE_APPROVED;
  delete process.env.TANTAPULSE_LEGACY_RESEND_SEND_ENABLED;
  delete process.env.TANTAPULSE_LIVE_RELEASE_APPROVED;
  global.fetch = async () => { throw new Error("legacy sender must not fetch while disabled"); };
  const response = responseRecorder();
  try {
    await legacySendHandler({ method: "GET", headers: {} }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.mode, "disabled");
  } finally {
    global.fetch = previousFetch;
    if (previousEnabled === undefined) delete process.env.TANTAPULSE_LEGACY_RESEND_SEND_ENABLED;
    else process.env.TANTAPULSE_LEGACY_RESEND_SEND_ENABLED = previousEnabled;
    if (previousRelease === undefined) delete process.env.TANTAPULSE_LIVE_RELEASE_APPROVED;
    else process.env.TANTAPULSE_LIVE_RELEASE_APPROVED = previousRelease;
  }
});

test("Apify launch endpoints reject untrusted calls before any spend check", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousFetch = global.fetch;
  process.env.CRON_SECRET = "test-cron-secret";
  global.fetch = async () => { throw new Error("untrusted Apify trigger must not fetch"); };
  try {
    for (const handler of [salesDiscoveryTriggerHandler, lane2TriggerHandler]) {
      const response = responseRecorder();
      await handler({ method: "POST", headers: {}, body: {} }, response);
      assert.equal(response.statusCode, 401);
    }
  } finally {
    global.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  }
});

test("only valid verified prospects are admitted", () => {
  assert.equal(normalizeProspect({ id: "lead-1", email: "a@example.com", verification: "accept_all" }, "tp-test"), null);
  const event = normalizeProspect({ id: "lead-1", email: "a@example.com", verification: "deliverable" }, "tp-test");
  assert.equal(event.event.event_type, "prospect.verified");
  assert.equal(event.event.prospect.utm_campaign, "tp-test");
});

test("prospect event identifiers are deterministic for retries", () => {
  const first = normalizeProspect({ id: "lead-1", email: "a@example.com", verification: "valid" }, "tp-test");
  const second = normalizeProspect({ id: "lead-1", email: "a@example.com", verification: "valid" }, "tp-test");
  assert.equal(first.event.event_id, second.event.event_id);
});

test("Hunter message normalization stores no subject or body", () => {
  const event = normalizeHunterMessage({ id: "m-1", lead: { id: "lead-1" }, status: "bounced", subject: "secret", body: "secret" });
  assert.equal(event.lifecycle_stage, "bounced");
  assert.equal(JSON.stringify(event).includes("secret"), false);
});

test("Atlas events receive a deterministic UUID and HMAC", async () => {
  const key = "hunter:message:m-1:contacted";
  assert.equal(stableUuid(key), stableUuid(key));
  const body = JSON.stringify({ event_id: stableUuid(key) });
  assert.match(hmacSignature(body, "secret"), /^sha256=/);
  const result = await postAtlasEvent({ endpoint: "https://atlas.test/event", ingestionSecret: "secret", event: { event_id: stableUuid(key) }, fetchImpl: async (url, options) => {
    assert.equal(options.method, "POST");
    assert.match(options.headers["X-Tanta-Signature"], /^sha256=/);
    return new Response(JSON.stringify({ status: "accepted" }), { status: 202 });
  } });
  assert.deepEqual(result, { ok: true, status: 202 });
});

test("Hunter pagination uses only GET and does not expose message contents in its result contract", async () => {
  const seen = [];
  const messages = await listHunterMessages({ sequenceId: "42", apiKey: "test-key", limit: 1, fetchImpl: async (url, options) => {
    seen.push({ url: String(url), method: options.method });
    const offset = new URL(url).searchParams.get("offset");
    const data = offset === "0" ? { data: { messages: [{ id: "m1" }] } } : { data: { messages: [] } };
    return new Response(JSON.stringify(data), { status: 200 });
  } });
  assert.equal(messages.length, 1);
  assert.deepEqual(seen.map((entry) => entry.method), ["GET", "GET"]);
});

test("Hunter verification uses a GET request and returns only the verification decision", async () => {
  const result = await verifyHunterEmail({ email: "a@example.com", apiKey: "test-key", fetchImpl: async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(new URL(url).pathname, "/v2/email-verifier");
    return new Response(JSON.stringify({ data: { status: "valid", score: 95, sources: [{ domain: "private" }] } }), { status: 200 });
  } });
  assert.deepEqual(result, { email: "a@example.com", status: "valid", score: 95 });
});

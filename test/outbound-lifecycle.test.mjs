import assert from "node:assert/strict";
import test from "node:test";

import { campaignGate, hmacSignature, listHunterMessages, makeNoSendReceipt, normalizeHunterMessage, normalizeProspect, postAtlasEvent, stableUuid } from "../lib/outbound-lifecycle.mjs";
import noSendHandler from "../api/outbound/no-send.js";
import reconcileHandler from "../api/outbound/reconcile.js";

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

test("no-send fixtures emit sanitized lifecycle plans without calling a provider", () => {
  const receipt = makeNoSendReceipt({ campaignId: "tp-test", fixtures: [
    { kind: "prospect", id: "lead-1", email: "avery@example.com", verification: "valid" },
    { id: "message-1", lead: { id: "lead-1" }, status: "replied", subject: "private", body: "private reply" },
  ] });
  assert.equal(receipt.mode, "no_send");
  assert.equal(receipt.planned_event_count, 2);
  assert.deepEqual(receipt.events.map((event) => event.event_type), ["prospect.verified", "prospect.stage_changed"]);
  assert.equal(JSON.stringify(receipt).includes("private"), false);
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

import assert from "node:assert/strict";
import test from "node:test";

const moduleUrl = new URL("../api/sample-request.js", import.meta.url);
const { default: handler } = await import(moduleUrl);

function request(body, { method = "POST", origin = "https://www.tantapulse.com" } = {}) {
  return { method, body, headers: { origin } };
}

function response() {
  return {
    statusCode: null,
    payload: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    setHeader(name, value) { this.headers[name] = value; },
  };
}

const validBody = {
  name: "  Ada  Lovelace ",
  email: "ADA@EXAMPLE.COM ",
  niche: "  Software   consulting ",
  city: " London  ",
  cadence: " weekly ",
  notes: " Need a sample ",
};

async function withCrmFetch(t, crmResponse, run) {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.THOS_SUPABASE_URL;
  const originalKey = process.env.THOS_SUPABASE_SERVICE_KEY;
  const calls = [];
  process.env.THOS_SUPABASE_URL = "https://crm.example.test";
  process.env.THOS_SUPABASE_SERVICE_KEY = "test-service-key";
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return crmResponse;
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.THOS_SUPABASE_URL;
    else process.env.THOS_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.THOS_SUPABASE_SERVICE_KEY;
    else process.env.THOS_SUPABASE_SERVICE_KEY = originalKey;
  }
}

function jsonResponse({ ok = true, status = 200, body = [] } = {}) {
  return { ok, status, json: async () => body };
}

test("persists one canonical CRM intake through the atomic RPC before returning a sanitized receipt", async (t) => {
  await withCrmFetch(t, jsonResponse({ body: [{
    receipt_id: "sir_opaque_123",
    status: "queued",
    owner: "sakuya",
    sla_due_at: "2026-07-22T12:00:00.000Z",
    duplicate: false,
  }] }), async (calls) => {
    const res = response();
    await handler(request(validBody), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, {
      ok: true,
      receipt_id: "sir_opaque_123",
      status: "queued",
      owner: "sakuya",
      sla_due_at: "2026-07-22T12:00:00.000Z",
      duplicate: false,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rest\/v1\/rpc\/intake_sample_request$/);
    const payload = JSON.parse(calls[0].options.body);
    assert.deepEqual({ ...payload, p_dedupe_key: "dedupe-key" }, {
      p_name: "Ada Lovelace",
      p_email: "ada@example.com",
      p_niche: "Software consulting",
      p_city: "London",
      p_cadence: "weekly",
      p_notes: "Need a sample",
      p_dedupe_key: "dedupe-key",
    });
    assert.match(payload.p_dedupe_key, /^sha256:[a-f0-9]{64}$/);
  });
});

test("returns the original receipt and duplicate indicator when the RPC resolves a retry", async (t) => {
  await withCrmFetch(t, jsonResponse({ body: [{
    receipt_id: "sir_opaque_123",
    status: "queued",
    owner: "sakuya",
    sla_due_at: "2026-07-22T12:00:00.000Z",
    duplicate: true,
  }] }), async (calls) => {
    const res = response();
    await handler(request(validBody), res);

    assert.equal(calls.length, 1);
    assert.deepEqual(res.payload, {
      ok: true,
      receipt_id: "sir_opaque_123",
      status: "queued",
      owner: "sakuya",
      sla_due_at: "2026-07-22T12:00:00.000Z",
      duplicate: true,
    });
  });
});

test("fails closed without exposing persistence transport details when CRM confirmation fails", async (t) => {
  await withCrmFetch(t, jsonResponse({ ok: false, status: 500, body: { message: "database socket failed" } }), async (calls) => {
    const res = response();
    await handler(request(validBody), res);

    assert.equal(calls.length, 1);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.payload, { error: "Unable to process request" });
    assert.doesNotMatch(JSON.stringify(res.payload), /database|socket|example/i);
  });
});

test("never calls Apify, Resend, Stripe, checkout, delivery, or lead-feed services", async (t) => {
  await withCrmFetch(t, jsonResponse({ body: [{
    receipt_id: "sir_opaque_123",
    status: "queued",
    owner: "sakuya",
    sla_due_at: "2026-07-22T12:00:00.000Z",
    duplicate: false,
  }] }), async (calls) => {
    const res = response();
    await handler(request(validBody), res);

    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    for (const call of calls) {
      assert.doesNotMatch(call.url, /(apify|resend|stripe|checkout|delivery|lead_feed)/i);
    }
  });
});

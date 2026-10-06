import { test } from "node:test";
import assert from "node:assert/strict";
import {
  domainOf,
  bestQualifyingEmail,
  bridgeOne,
  HUNTER_MIN_CONFIDENCE,
} from "../lib/lead-feed-bridge.mjs";

test("domainOf strips protocol and www", () => {
  assert.equal(domainOf("https://www.example.com/path"), "example.com");
  assert.equal(domainOf("example.com"), "example.com");
  assert.equal(domainOf(""), "");
  assert.equal(domainOf(null), "");
});

test("bestQualifyingEmail requires confidence >= 80 AND verification status exactly 'valid'", () => {
  assert.equal(
    bestQualifyingEmail({
      emails: [
        { value: "a@x.com", confidence: 79, verification: { status: "valid" } },
        {
          value: "b@x.com",
          confidence: 95,
          verification: { status: "invalid" },
        },
        {
          value: "c@x.com",
          confidence: 95,
          verification: { status: "webmail" },
        },
      ],
    }),
    null,
  );

  const picked = bestQualifyingEmail({
    emails: [
      { value: "low@x.com", confidence: 81, verification: { status: "valid" } },
      {
        value: "high@x.com",
        confidence: 97,
        verification: { status: "Valid" },
      },
    ],
  });
  assert.equal(picked.value, "high@x.com");
  assert.ok(picked.confidence >= HUNTER_MIN_CONFIDENCE);
});

test("bestQualifyingEmail returns null for no emails / malformed input", () => {
  assert.equal(bestQualifyingEmail(null), null);
  assert.equal(bestQualifyingEmail({}), null);
  assert.equal(bestQualifyingEmail({ emails: [] }), null);
});

function fakeDb() {
  const patches = [];
  const inserts = { contacts: [], leads: [] };
  return {
    patches,
    inserts,
    get: async (path) => {
      if (path.startsWith("contacts?")) return []; // no existing contact
      throw new Error(`unexpected get ${path}`);
    },
    insert: async (table, body) => {
      const id = table === "contacts" ? "contact-uuid-1" : "lead-uuid-1";
      inserts[table].push(body);
      return [{ id }];
    },
    patch: async (path, body) => {
      patches.push({ path, body });
      return null;
    },
  };
}

test("bridgeOne marks no_email when the website has no usable domain", async () => {
  const d = fakeDb();
  const log = [];
  const outcome = await bridgeOne(
    d,
    { id: 1, business_name: "Acme", website: "" },
    "key",
    log,
  );
  assert.equal(outcome, "no_email");
  assert.equal(d.patches[0].body.bridge_status, "no_email");
  assert.ok(d.patches[0].body.bridge_checked_at);
});

test("bridgeOne creates contacts+leads and marks bridged when Hunter clears the bar", async (t) => {
  const d = fakeDb();
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        emails: [
          {
            value: "owner@acme.com",
            confidence: 92,
            verification: { status: "valid" },
          },
        ],
      },
    }),
  }));
  const log = [];
  const outcome = await bridgeOne(
    d,
    {
      id: 2,
      run_id: "run-1",
      business_name: "Acme",
      website: "https://acme.com",
    },
    "key",
    log,
  );
  assert.equal(outcome, "bridged");
  assert.equal(d.inserts.contacts[0].email, "owner@acme.com");
  assert.equal(d.inserts.leads[0].source, "apify");
  assert.equal(d.inserts.leads[0].hunter_verifier_status, "valid");
  assert.equal(d.inserts.leads[0].outreach_status, "pending");
  assert.equal(d.inserts.leads[0].outreach_sequence, 0);
  assert.ok(
    d.inserts.leads[0].first_seen_at,
    "first_seen_at must be set -- leads.first_seen_at is NOT NULL with no DB default",
  );
  const finalPatch = d.patches[d.patches.length - 1];
  assert.equal(finalPatch.body.bridge_status, "bridged");
  assert.equal(finalPatch.body.bridged_lead_id, "lead-uuid-1");
});

test("bridgeOne marks low_confidence when an email exists but never clears the bar", async (t) => {
  const d = fakeDb();
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        emails: [
          {
            value: "info@acme.com",
            confidence: 40,
            verification: { status: "valid" },
          },
        ],
      },
    }),
  }));
  const log = [];
  const outcome = await bridgeOne(
    d,
    { id: 3, business_name: "Acme", website: "https://acme.com" },
    "key",
    log,
  );
  assert.equal(outcome, "low_confidence");
  assert.equal(d.patches[0].body.bridge_status, "low_confidence");
});

test("bridgeOne marks error (not an unhandled throw) when creating the lead/contact fails", async (t) => {
  const d = fakeDb();
  d.insert = async (table) => {
    if (table === "contacts") return [{ id: "contact-uuid-1" }];
    throw new Error(
      'db POST leads 400: {"code":"23502","message":"null value in column \\"first_seen_at\\" violates not-null constraint"}',
    );
  };
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        emails: [
          {
            value: "owner@acme.com",
            confidence: 92,
            verification: { status: "valid" },
          },
        ],
      },
    }),
  }));
  const log = [];
  const outcome = await bridgeOne(
    d,
    { id: 5, business_name: "Acme", website: "https://acme.com" },
    "key",
    log,
  );
  assert.equal(outcome, "error");
  assert.equal(d.patches[0].body.bridge_status, "error");
  assert.ok(d.patches[0].body.bridge_checked_at);
});

test("bridgeOne marks error (and still records bridge_checked_at) when Hunter call fails", async (t) => {
  const d = fakeDb();
  t.mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  }));
  const log = [];
  const outcome = await bridgeOne(
    d,
    { id: 4, business_name: "Acme", website: "https://acme.com" },
    "key",
    log,
  );
  assert.equal(outcome, "error");
  assert.equal(d.patches[0].body.bridge_status, "error");
  assert.ok(d.patches[0].body.bridge_checked_at);
});

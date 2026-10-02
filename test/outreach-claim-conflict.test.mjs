import test from "node:test";
import assert from "node:assert/strict";
import { sendOutreachTouch } from "../api/sample-intake/fulfill.js";

const lead = { id: "lead-1", company: "Acme", domain: "acme.test", contact: { email: "Owner@Acme.test" } };
const opts = { sequence: 2, render: () => ({ subject: "s", html: "h" }), label: "outreach follow-up" };

function fakeDb({ insert, existing }) {
  const patches = [];
  return {
    patches,
    get: async (p) => (p.startsWith("pulse_outreach_sends?lead_id=eq.") ? (existing ? [existing] : []) : []),
    insert,
    patch: async (p, b) => { patches.push([p, b]); },
    del: async () => {},
  };
}

test("existing (lead, sequence) claim reconciles the lead and never resends", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("must not send or call resend on a conflict"); };
  try {
    const d = fakeDb({
      existing: { id: "c1", resend_id: "re_123" },
      insert: async () => { throw new Error('db POST pulse_outreach_sends 409: {"code":"23505","details":"Key (lead_id, sequence)=(lead-1, 2) already exists."}'); },
    });
    const log = [];
    const sent = await sendOutreachTouch(d, log, lead, opts);
    assert.equal(sent, false);
    assert.deepEqual(d.patches.map(([p, b]) => [p, b.outreach_status, b.outreach_sequence]), [["leads?id=eq.lead-1", "emailed", 2]]);
    assert.match(log[0], /already claimed \(re_123\), lead reconciled/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an orphan claim with no resend_id is reconciled and flagged unverified, not resent", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("must not send"); };
  try {
    const d = fakeDb({
      existing: { id: "c2", resend_id: null },
      insert: async () => { throw new Error('db POST pulse_outreach_sends 409: {"code":"23505"'); },
    });
    const log = [];
    assert.equal(await sendOutreachTouch(d, log, lead, opts), false);
    assert.match(log[0], /delivery unverified/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a non-conflict database error still propagates", async () => {
  const d = fakeDb({ insert: async () => { throw new Error("db POST pulse_outreach_sends 500: boom"); } });
  await assert.rejects(() => sendOutreachTouch(d, [], lead, opts), /500: boom/);
  assert.equal(d.patches.length, 0);
});

test("the status written for a follow-up is one the leads_outreach_status_check constraint allows", async () => {
  const allowed = ["not_queued", "pending", "eligible", "queued", "sent", "emailed", "replied", "converted", "suppressed", "dead"];
  const d = fakeDb({ existing: { id: "c3", resend_id: "re_9" }, insert: async () => { throw new Error('db POST pulse_outreach_sends 409: {"code":"23505"'); } });
  await sendOutreachTouch(d, [], lead, opts);
  assert.ok(allowed.includes(d.patches[0][1].outreach_status));
});

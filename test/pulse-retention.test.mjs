import test from "node:test";
import assert from "node:assert/strict";
import { runRetention, cutoffIso, RETENTION_MONTHS, purgedEmail } from "../lib/pulse-retention.mjs";
import handler, { retentionDb } from "../api/pulse/retention-purge.js";

const NOW = new Date("2028-10-04T00:00:00Z");

// Scripted fake PostgREST. get() returns canned rows by table; keyset pages (id=gt.) return [].
function fakeDb(data) {
  const calls = [];
  const d = {
    calls,
    async get(path) {
      calls.push({ m: "GET", path });
      if (/[?&]id=gt\./.test(path)) return [];
      const table = path.split("?")[0];
      if (table === "leads" && /contact_id=in\./.test(path)) return data.leadRefs || [];
      if (table === "leads" && /or=\(outreach_status/.test(path)) return data.badLeads || [];
      if (table === "pulse_email_events" && /resend_id=in\./.test(path)) return data.badSendEvents || [];
      if (table === "contacts") {
        const ids = (/id=in\.\(([^)]*)\)/.exec(path) || [])[1]?.split(",") || [];
        return (data.contacts || []).filter((c) => ids.includes(c.id));
      }
      return data[table] || [];
    },
    async patch(path, body) {
      calls.push({ m: "PATCH", path, body });
    },
    async del(path) {
      calls.push({ m: "DELETE", path });
    },
    async insert(path, body, extra) {
      calls.push({ m: "POST", path, body, extra });
    },
  };
  return d;
}

const dataset = () => ({
  paid_subscribers: [{ email: "Paying@Agency.com", lead_id: "lead-paid" }],
  sample_intake_requests: [
    { id: "i1", request_email: "old@example.com" },
    { id: "i2", request_email: "paying@agency.com" },
  ],
  lead_feed_runs: [{ id: "r1", request_email: "old@example.com" }],
  pulse_outreach_sends: [
    { id: "s1", email: "gone@x.com", lead_id: "lead-bad", resend_id: "re1" },
    { id: "s2", email: "ok@x.com", lead_id: "lead-ok", resend_id: "re2" },
    { id: "s3", email: "paying@agency.com", lead_id: "lead-paid", resend_id: "re3" },
  ],
  badLeads: [{ id: "lead-bad" }],
  pulse_email_events: [
    { id: 1, recipient: "bounced@x.com", event_type: "email.bounced" },
    { id: 2, recipient: "fine@x.com", event_type: "email.delivered" },
    { id: 3, recipient: "paying@agency.com", event_type: "email.bounced" },
  ],
  lead_feed_leads: [
    { id: 10, email: null, run: { source: "sample_intake" } },
    { id: 11, email: null, run: { source: "paid_weekly" } },
  ],
  leads: [
    { id: "l1", contact_id: "c1", outreach_status: "pending" },
    { id: "l2", contact_id: "c2", outreach_status: "emailed" },
    { id: "l-paid", contact_id: "c3", outreach_status: "emailed" },
  ],
  leadRefs: [
    { id: "l1", contact_id: "c1" },
    { id: "l2", contact_id: "c2" },
    { id: "other", contact_id: "c2" },
  ],
  contacts: [{ id: "c1" }, { id: "c2" }],
});

const writes = (d) => d.calls.filter((c) => c.m !== "GET");

test("retention window is 24 months", () => {
  assert.equal(RETENTION_MONTHS, 24);
  assert.equal(cutoffIso(NOW), "2026-10-04T00:00:00.000Z");
});

test("dry run reports counts and performs zero writes", async () => {
  const d = fakeDb(dataset());
  const r = await runRetention(d, { now: NOW });
  assert.equal(r.mode, "dry_run");
  assert.deepEqual(r.errors, []);
  assert.equal(writes(d).length, 0);
  assert.equal(r.counts.sample_intake_requests, 1); // paying subscriber intake skipped
  assert.equal(r.counts.pulse_outreach_sends, 2); // paid lead/email send skipped
  assert.equal(r.counts.pulse_email_events, 2); // paying subscriber event skipped
  assert.equal(r.counts.lead_feed_leads, 1); // paid_weekly delivery kept
  assert.equal(r.counts.crm_contacts_anonymized, 1); // c2 is shared with a non-eligible lead
  assert.equal(r.counts.suppression_addresses_preserved, 2); // bounced@x.com + gone@x.com
});

test("apply never deletes or modifies suppression, subscriber or billing tables", async () => {
  const d = fakeDb(dataset());
  await runRetention(d, { now: NOW, apply: true });
  const protectedTables = ["lead_feed_unsubscribes", "tanta_pulse_suppressions", "paid_subscribers", "hunter_suppressions"];
  for (const c of writes(d)) {
    const table = c.path.split("?")[0];
    if (protectedTables.includes(table)) {
      assert.equal(c.m, "POST", `only insert-ignore allowed on ${table}, saw ${c.m}`);
      assert.equal(table, "lead_feed_unsubscribes");
      assert.match(c.extra.Prefer, /ignore-duplicates/);
    }
  }
  assert.ok(!writes(d).some((c) => c.m === "DELETE" && /lead_feed_unsubscribes|tanta_pulse_suppressions|paid_subscribers/.test(c.path)));
});

test("bounce and complaint addresses are preserved before their records are purged", async () => {
  const d = fakeDb(dataset());
  await runRetention(d, { now: NOW, apply: true });
  const inserts = writes(d).filter((c) => c.m === "POST");
  const emails = inserts.flatMap((c) => c.body.map((b) => b.email)).sort();
  assert.deepEqual(emails, ["bounced@x.com", "gone@x.com"]);
  const firstInsert = d.calls.findIndex((c) => c.m === "POST");
  const firstDelete = d.calls.findIndex((c) => c.m === "DELETE");
  assert.ok(firstInsert < firstDelete, "preserve before delete");
});

test("apply anonymizes intake PII, deletes sends/events/unconverted leads, keeps paid-subscriber rows", async () => {
  const d = fakeDb(dataset());
  const r = await runRetention(d, { now: NOW, apply: true });
  assert.deepEqual(r.errors, []);
  const w = writes(d);
  const intake = w.filter((c) => c.m === "PATCH" && c.path.startsWith("sample_intake_requests"));
  assert.equal(intake.length, 1);
  assert.equal(intake[0].body.request_email, purgedEmail("i1"));
  assert.equal(intake[0].body.request_name, "[removed]");
  const delSends = w.find((c) => c.m === "DELETE" && c.path.startsWith("pulse_outreach_sends"));
  assert.match(delSends.path, /s1,s2/);
  assert.doesNotMatch(delSends.path, /s3/);
  const delEvents = w.find((c) => c.m === "DELETE" && c.path.startsWith("pulse_email_events"));
  assert.match(delEvents.path, /\(1,2\)/);
  const delLeads = w.find((c) => c.m === "DELETE" && c.path.startsWith("lead_feed_leads"));
  assert.match(delLeads.path, /\(10\)/);
});

test("CRM leads are un-queued before the contact is wiped; shared, paid and suppressed leads are untouched", async () => {
  const d = fakeDb(dataset());
  await runRetention(d, { now: NOW, apply: true });
  const w = writes(d);
  const unqueue = w.findIndex((c) => c.m === "PATCH" && c.path.startsWith("leads?"));
  const wipe = w.findIndex((c) => c.m === "PATCH" && c.path.startsWith("contacts?"));
  assert.ok(unqueue >= 0 && wipe > unqueue);
  assert.equal(w[unqueue].body.outreach_status, "not_queued");
  const contactPatches = w.filter((c) => c.path.startsWith("contacts?"));
  assert.equal(contactPatches.length, 1);
  assert.match(contactPatches[0].path, /c1/);
  assert.equal(contactPatches[0].body.email, purgedEmail("c1"));
  assert.ok(!w.some((c) => c.m === "DELETE" && c.path.startsWith("leads")));
  const q = d.calls.find((c) => c.m === "GET" && c.path.startsWith("leads?created_at"));
  assert.match(q.path, /outreach_status=not\.in\.\(suppressed,bounced,replied\)/);
  assert.match(q.path, /lifecycle_stage=in\.\(new,lead\)/);
  assert.match(q.path, /converted_at=is\.null/);
});

test("route is dry-run unless PULSE_RETENTION_PURGE_ENABLED is exactly true", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push(`${init.method || "GET"} ${url}`);
    return { ok: true, text: async () => "[]" };
  };
  process.env.CRON_SECRET = "s";
  process.env.THOS_SUPABASE_URL = "https://x.supabase.co";
  process.env.THOS_SUPABASE_SERVICE_KEY = "k";
  const run = async (flag, auth = "Bearer s") => {
    if (flag === undefined) delete process.env.PULSE_RETENTION_PURGE_ENABLED;
    else process.env.PULSE_RETENTION_PURGE_ENABLED = flag;
    let status;
    let body;
    await handler(
      { headers: { authorization: auth } },
      {
        status(c) {
          status = c;
          return this;
        },
        json(b) {
          body = b;
          return this;
        },
      },
    );
    return { status, body };
  };
  try {
    assert.equal((await run("true", "Bearer wrong")).status, 401);
    for (const flag of [undefined, "false", "1", "TRUE", ""]) {
      const { status, body } = await run(flag);
      assert.equal(status, 200);
      assert.equal(body.mode, "dry_run", `flag=${flag}`);
    }
    assert.equal((await run("true")).body.mode, "apply");
    assert.ok(!seen.some((s) => s.startsWith("DELETE")), "no deletes on empty data");
    assert.equal(retentionDb({}).ok, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

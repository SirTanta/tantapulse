/**
 * Tanta Pulse 24-month retention purge (MCA-1970).
 *
 * Applies the retention period stated in the Tanta Pulse section of the privacy
 * policy. One idempotent pass per call. DRY-RUN BY DEFAULT: `apply` must be
 * explicitly true (the API route sets it only when PULSE_RETENTION_PURGE_ENABLED
 * is exactly "true").
 *
 * What it does with records older than RETENTION_MONTHS:
 *   sample_intake_requests   anonymize requester PII (name, email, notes, dedupe hash)
 *   lead_feed_runs           anonymize requester PII on market-check runs (source sample_intake)
 *   pulse_outreach_sends     delete
 *   pulse_email_events       delete
 *   lead_feed_leads          delete unconverted rows (public business listing data)
 *   leads / contacts (CRM)   anonymize the contact PII of unconverted cold-outreach leads
 *                            and stop them being picked up for sending. Lead rows are kept
 *                            so the shared CRM foreign-key graph stays intact.
 *
 * HARD RULES (enforced here and covered by test/pulse-retention.test.mjs):
 *   - Suppression / opt-out data is never deleted or aged out: lead_feed_unsubscribes,
 *     tanta_pulse_suppressions, and suppressed/bounced/unsubscribed leads are never modified.
 *     Before an event or send row is purged, any bounce/complaint address it carries is
 *     copied INTO lead_feed_unsubscribes (insert-only, ignore duplicates) so it stays blocked.
 *   - paid_subscribers and billing records are never touched, and neither is any row tied to a
 *     paid subscriber (by email or lead_id).
 *   - Engaged/converted leads are kept (replied, any lifecycle stage other than new/lead,
 *     converted_at set, referenced by a recent sample request).
 */

export const RETENTION_MONTHS = 24;
export const PAGE_SIZE = 500;
export const MAX_ROWS_PER_TABLE = 5000;
export const PURGED_DOMAIN = "purged.invalid";
const BAD_EVENTS = ["email.bounced", "email.complained"];

export function cutoffIso(now = new Date(), months = RETENTION_MONTHS) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

export function purgedEmail(id) {
  return `purged-${id}@${PURGED_DOMAIN}`;
}

const lc = (v) => String(v || "").trim().toLowerCase();
const inList = (ids) => `(${ids.join(",")})`;
function chunks(arr, n = 100) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Keyset-paginated read so the result is stable whether or not earlier rows were mutated.
async function readAll(d, basePath, { cap = MAX_ROWS_PER_TABLE, key = "id" } = {}) {
  const rows = [];
  let last = null;
  while (rows.length < cap) {
    const after = last === null ? "" : `&${key}=gt.${encodeURIComponent(last)}`;
    const page = await d.get(`${basePath}${after}&order=${key}.asc&limit=${PAGE_SIZE}`);
    if (!Array.isArray(page) || !page.length) break;
    rows.push(...page);
    last = page[page.length - 1][key];
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function loadProtected(d, cutoff) {
  const subs = await d.get("paid_subscribers?select=email,lead_id&limit=10000");
  const paidEmails = new Set(subs.map((s) => lc(s.email)).filter(Boolean));
  const paidLeadIds = new Set(subs.map((s) => s.lead_id).filter(Boolean));
  const recent = await d.get(
    `sample_intake_requests?lead_id=not.is.null&created_at=gte.${cutoff}&select=lead_id&limit=10000`,
  );
  const recentLeadIds = new Set(recent.map((r) => r.lead_id));
  return { paidEmails, paidLeadIds, recentLeadIds };
}

// Copy bounce/complaint addresses into the permanent opt-out list before their evidence is purged.
async function preserveBadAddresses(d, emails, apply, counts) {
  const unique = [...new Set(emails.map(lc).filter(Boolean))];
  counts.suppression_addresses_preserved += unique.length;
  if (!apply || !unique.length) return;
  for (const part of chunks(unique, 100)) {
    await d.insert(
      "lead_feed_unsubscribes?on_conflict=email",
      part.map((email) => ({ email, source: "retention_purge_preserved_bounce_or_complaint" })),
      { Prefer: "resolution=ignore-duplicates,return=minimal" },
    );
  }
}

async function purgeEvents(d, cutoff, prot, apply, counts) {
  const rows = await readAll(d, `pulse_email_events?occurred_at=lt.${cutoff}&select=id,recipient,event_type`);
  const eligible = rows.filter((r) => !prot.paidEmails.has(lc(r.recipient)));
  counts.pulse_email_events = eligible.length;
  await preserveBadAddresses(
    d,
    eligible.filter((r) => BAD_EVENTS.includes(r.event_type)).map((r) => r.recipient),
    apply,
    counts,
  );
  if (!apply) return;
  for (const part of chunks(eligible.map((r) => r.id))) await d.del(`pulse_email_events?id=in.${inList(part)}`);
}

async function purgeSends(d, cutoff, prot, apply, counts) {
  const rows = await readAll(d, `pulse_outreach_sends?sent_at=lt.${cutoff}&select=id,email,lead_id,resend_id`);
  const eligible = rows.filter((r) => !prot.paidEmails.has(lc(r.email)) && !prot.paidLeadIds.has(r.lead_id));
  counts.pulse_outreach_sends = eligible.length;
  // Keep addresses whose lead ended suppressed/bounced blocked after the send row is gone.
  const leadIds = [...new Set(eligible.map((r) => r.lead_id).filter(Boolean))];
  const badLeads = new Set();
  for (const part of chunks(leadIds)) {
    const leads = await d.get(`leads?id=in.${inList(part)}&or=(outreach_status.in.(suppressed,bounced),lifecycle_stage.in.(bounced,unsubscribed))&select=id`);
    leads.forEach((l) => badLeads.add(l.id));
  }
  // Same for sends whose Resend id has a bounce/complaint event of any age.
  const badSendIds = new Set();
  const resendIds = [...new Set(eligible.map((r) => r.resend_id).filter(Boolean))];
  for (const part of chunks(resendIds)) {
    const ev = await d.get(`pulse_email_events?resend_id=in.${inList(part)}&event_type=in.(${BAD_EVENTS.join(",")})&select=resend_id`);
    ev.forEach((e) => badSendIds.add(e.resend_id));
  }
  await preserveBadAddresses(
    d,
    eligible.filter((r) => badLeads.has(r.lead_id) || badSendIds.has(r.resend_id)).map((r) => r.email),
    apply,
    counts,
  );
  if (!apply) return;
  for (const part of chunks(eligible.map((r) => r.id))) await d.del(`pulse_outreach_sends?id=in.${inList(part)}`);
}

async function purgeIntakes(d, cutoff, prot, apply, counts) {
  const rows = await readAll(
    d,
    `sample_intake_requests?created_at=lt.${cutoff}&request_email=not.like.*@${PURGED_DOMAIN}&select=id,request_email`,
  );
  const eligible = rows.filter((r) => !prot.paidEmails.has(lc(r.request_email)));
  counts.sample_intake_requests = eligible.length;
  if (!apply) return;
  for (const r of eligible) {
    await d.patch(`sample_intake_requests?id=eq.${r.id}`, {
      request_name: "[removed]",
      request_email: purgedEmail(r.id),
      notes: "",
      dedupe_key: `purged:${r.id}`,
      updated_at: new Date().toISOString(),
    });
  }
}

async function purgeRuns(d, cutoff, prot, apply, counts) {
  const rows = await readAll(
    d,
    `lead_feed_runs?created_at=lt.${cutoff}&source=eq.sample_intake&request_email=not.is.null&request_email=not.like.*@${PURGED_DOMAIN}&select=id,request_email`,
  );
  const eligible = rows.filter((r) => !prot.paidEmails.has(lc(r.request_email)));
  counts.lead_feed_runs = eligible.length;
  if (!apply) return;
  for (const r of eligible) {
    await d.patch(`lead_feed_runs?id=eq.${r.id}`, {
      request_name: "[removed]",
      request_email: purgedEmail(r.id),
      notes: null,
      updated_at: new Date().toISOString(),
    });
  }
}

async function purgeLeadFeedLeads(d, cutoff, prot, apply, counts) {
  const rows = await readAll(
    d,
    `lead_feed_leads?created_at=lt.${cutoff}&stripe_customer_id=is.null&subscription_status=is.null&paid_at=is.null&booked_at=is.null&response_at=is.null&select=id,email,run:lead_feed_runs(source)`,
  );
  // paid_weekly deliveries back the "never resend a business to this subscriber" guarantee.
  const eligible = rows.filter((r) => r.run?.source !== "paid_weekly" && !prot.paidEmails.has(lc(r.email)));
  counts.lead_feed_leads = eligible.length;
  if (!apply) return;
  for (const part of chunks(eligible.map((r) => r.id))) await d.del(`lead_feed_leads?id=in.${inList(part)}`);
}

async function purgeCrmLeads(d, cutoff, prot, apply, counts) {
  const rows = await readAll(
    d,
    `leads?created_at=lt.${cutoff}&source=in.(apify,tantapulse_seo_agency)&converted_at=is.null&lifecycle_stage=in.(new,lead)&outreach_status=not.in.(suppressed,bounced,replied)&contact_id=not.is.null&select=id,contact_id,outreach_status`,
  );
  const leads = rows.filter((l) => !prot.paidLeadIds.has(l.id) && !prot.recentLeadIds.has(l.id));
  const eligibleLeadIds = new Set(leads.map((l) => l.id));
  // Only anonymize a contact when every lead that points at it is itself eligible.
  const contactIds = [...new Set(leads.map((l) => l.contact_id))];
  const blocked = new Set();
  for (const part of chunks(contactIds)) {
    const refs = await d.get(`leads?contact_id=in.${inList(part)}&select=id,contact_id`);
    refs.filter((r) => !eligibleLeadIds.has(r.id)).forEach((r) => blocked.add(r.contact_id));
  }
  const contacts = [];
  for (const part of chunks(contactIds.filter((c) => !blocked.has(c)))) {
    contacts.push(...(await d.get(`contacts?id=in.${inList(part)}&email=not.like.*@${PURGED_DOMAIN}&select=id`)));
  }
  counts.crm_contacts_anonymized = contacts.length;
  const okContact = new Set(contacts.map((c) => c.id));
  const leadsToStop = leads.filter((l) => okContact.has(l.contact_id) && ["pending", "eligible"].includes(l.outreach_status));
  counts.crm_leads_unqueued = leadsToStop.length;
  if (!apply) return;
  // Stop the sender from picking these up BEFORE the address is wiped.
  for (const part of chunks(leadsToStop.map((l) => l.id))) {
    await d.patch(`leads?id=in.${inList(part)}`, { outreach_status: "not_queued", updated_at: new Date().toISOString() });
  }
  for (const c of contacts) {
    await d.patch(`contacts?id=eq.${c.id}`, {
      first_name: null,
      last_name: null,
      phone: null,
      email: purgedEmail(c.id),
      updated_at: new Date().toISOString(),
    });
  }
}

/**
 * @param {{get:Function,patch:Function,del:Function,insert:Function}} d
 * @param {{now?:Date, apply?:boolean}} opts
 */
export async function runRetention(d, { now = new Date(), apply = false } = {}) {
  const cutoff = cutoffIso(now);
  const counts = {
    sample_intake_requests: 0,
    lead_feed_runs: 0,
    pulse_outreach_sends: 0,
    pulse_email_events: 0,
    lead_feed_leads: 0,
    crm_contacts_anonymized: 0,
    crm_leads_unqueued: 0,
    suppression_addresses_preserved: 0,
  };
  const errors = [];
  const prot = await loadProtected(d, cutoff);
  // Order matters: leads (needs sends' lead refs intact) is independent; sends/events preserve
  // bounce evidence before deleting it.
  const steps = [
    ["pulse_email_events", purgeEvents],
    ["pulse_outreach_sends", purgeSends],
    ["sample_intake_requests", purgeIntakes],
    ["lead_feed_runs", purgeRuns],
    ["lead_feed_leads", purgeLeadFeedLeads],
    ["crm_leads", purgeCrmLeads],
  ];
  for (const [name, fn] of steps) {
    try {
      await fn(d, cutoff, prot, apply, counts);
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  return { mode: apply ? "apply" : "dry_run", retention_months: RETENTION_MONTHS, cutoff, counts, errors };
}

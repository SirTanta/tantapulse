/**
 * Bridges lead_feed_leads (Apify Google-Places discovery -- scored, deduped, but with
 * no verified email) into the one real outreach-sending path: api/sample-intake/fulfill.js's
 * outreach(), which only ever reads the `leads` table filtered on
 * hunter_confidence>=80 AND hunter_verifier_status ilike 'valid'.
 *
 * This module does not send anything and does not touch the daily/pass outreach caps.
 * It only (a) looks up a verified email for a scored lead_feed_leads business via Hunter.io
 * Domain Search, and (b) when that email clears the exact same bar the existing Austin SEO
 * outreach pool already uses, creates a `contacts` + `leads` row so the existing, unmodified
 * outreach() function picks it up on its next pass -- same cap, same vetting bar, same code path.
 */
import { createHash } from "node:crypto";

export const HUNTER_MIN_CONFIDENCE = 80;
export const BRIDGE_BATCH_SIZE = 20;

export function domainOf(url) {
  if (!url) return "";
  try {
    return new URL(
      url.startsWith("http") ? url : `https://${url}`,
    ).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export async function hunterDomainSearch(domain, apiKey) {
  const res = await fetch(
    `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${encodeURIComponent(apiKey)}&limit=1`,
  );
  const json = await res.json().catch(() => null);
  if (res.status === 429) throw new Error("hunter rate limited (429)");
  if (!res.ok)
    throw new Error(
      `hunter domain-search ${res.status}: ${JSON.stringify(json).slice(0, 200)}`,
    );
  return json?.data || null;
}

// Mirrors the exact bar eligibleOutreach() applies to the existing Austin SEO pool:
// hunter_confidence>=80 and hunter_verifier_status ilike 'valid' (exact word, case-insensitive).
export function bestQualifyingEmail(hunterData) {
  const emails = Array.isArray(hunterData?.emails) ? hunterData.emails : [];
  const qualifying = emails
    .filter(
      (e) => e?.value && Number(e.confidence || 0) >= HUNTER_MIN_CONFIDENCE,
    )
    .filter(
      (e) => String(e?.verification?.status || "").toLowerCase() === "valid",
    )
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
  return qualifying[0] || null;
}

function shortHash(input) {
  return createHash("sha1").update(String(input)).digest("hex").slice(0, 16);
}

async function findOrCreateContact(d, email, best) {
  const normalized = email.toLowerCase();
  const existing = await d.get(
    `contacts?email=eq.${encodeURIComponent(normalized)}&select=id&limit=1`,
  );
  if (existing.length) return existing[0].id;
  const [row] = await d.insert("contacts", {
    email: normalized,
    first_name: best?.first_name || null,
    last_name: best?.last_name || null,
    external_id: `pulse-lead-feed-bridge-${shortHash(normalized)}`,
  });
  return row.id;
}

async function createOutreachLead(d, { lead, domain, best }) {
  const contactId = await findOrCreateContact(d, best.value, best);
  const [leadRow] = await d.insert("leads", {
    contact_id: contactId,
    source: "apify",
    company: lead.business_name,
    domain,
    display_name: lead.business_name,
    hunter_confidence: Math.round(Number(best.confidence || 0)),
    hunter_verifier_status: "valid",
    outreach_status: "pending",
    outreach_sequence: 0,
    source_run_id: lead.run_id || null,
    // leads.first_seen_at is NOT NULL with no DB default -- every other writer
    // (Stripe/Hunter outbound) sets it explicitly; this bridge must too.
    first_seen_at: new Date().toISOString(),
  });
  return leadRow.id;
}

export async function candidates(d, limit = BRIDGE_BATCH_SIZE) {
  const q = new URLSearchParams({
    select: "id,run_id,business_name,website,niche,city,score_band",
    source_type: "eq.real",
    score_band: "in.(high,usable)",
    website: "not.is.null",
    or: "(bridge_checked_at.is.null,bridge_status.eq.error)",
    order: "lead_score.desc",
    limit: String(limit),
  });
  return d.get(`lead_feed_leads?${q.toString()}`);
}

export async function bridgeOne(d, lead, hunterKey, log) {
  const domain = domainOf(lead.website);
  if (!domain) {
    await d.patch(`lead_feed_leads?id=eq.${lead.id}`, {
      bridge_status: "no_email",
      bridge_checked_at: new Date().toISOString(),
    });
    log.push(
      `bridge ${lead.id} (${lead.business_name}) -> no_email (no usable domain)`,
    );
    return "no_email";
  }

  let data;
  try {
    data = await hunterDomainSearch(domain, hunterKey);
  } catch (err) {
    await d.patch(`lead_feed_leads?id=eq.${lead.id}`, {
      bridge_status: "error",
      bridge_checked_at: new Date().toISOString(),
    });
    log.push(
      `bridge ${lead.id} (${lead.business_name}) -> error (${err.message})`,
    );
    return "error";
  }

  const best = bestQualifyingEmail(data);
  if (!best) {
    const hadAnyEmail = Array.isArray(data?.emails) && data.emails.length > 0;
    await d.patch(`lead_feed_leads?id=eq.${lead.id}`, {
      bridge_status: hadAnyEmail ? "low_confidence" : "no_email",
      bridge_checked_at: new Date().toISOString(),
    });
    log.push(
      `bridge ${lead.id} (${lead.business_name}) -> ${hadAnyEmail ? "low_confidence" : "no_email"} (${domain})`,
    );
    return hadAnyEmail ? "low_confidence" : "no_email";
  }

  // A failure here (e.g. an unexpected NOT NULL/FK constraint) must not abort the rest
  // of the batch -- mark this one row recoverable ("error") and let the loop continue.
  let leadId;
  try {
    leadId = await createOutreachLead(d, { lead, domain, best });
  } catch (err) {
    await d.patch(`lead_feed_leads?id=eq.${lead.id}`, {
      bridge_status: "error",
      bridge_checked_at: new Date().toISOString(),
    });
    log.push(
      `bridge ${lead.id} (${lead.business_name}) -> error creating lead/contact (${err.message})`,
    );
    return "error";
  }

  await d.patch(`lead_feed_leads?id=eq.${lead.id}`, {
    bridged_lead_id: leadId,
    bridge_status: "bridged",
    bridge_checked_at: new Date().toISOString(),
  });
  log.push(
    `bridge ${lead.id} (${lead.business_name}) -> bridged, leads.id=${leadId} (confidence ${best.confidence})`,
  );
  return "bridged";
}

export async function runBridge(d, hunterKey, log, limit = BRIDGE_BATCH_SIZE) {
  const rows = await candidates(d, limit);
  const counts = { bridged: 0, no_email: 0, low_confidence: 0, error: 0 };
  for (const lead of rows) {
    const outcome = await bridgeOne(d, lead, hunterKey, log);
    counts[outcome] = (counts[outcome] || 0) + 1;
  }
  return { checked: rows.length, counts };
}

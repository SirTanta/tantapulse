import { normalizeProspect, postAtlasEvent, verificationGate, verifyHunterEmail } from "../../lib/outbound-lifecycle.mjs";
import { createOutboundStore } from "../../lib/outbound-store.mjs";

function authorized(req) {
  return Boolean(process.env.CRON_SECRET) && req.headers?.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

function config(approval, hunterApiKey) {
  return {
    mode: process.env.TANTAPULSE_OUTBOUND_MODE,
    liveReleaseApproved: process.env.TANTAPULSE_LIVE_RELEASE_APPROVED,
    verificationApproved: process.env.TANTAPULSE_HUNTER_VERIFICATION_APPROVED,
    sourceFilterKey: process.env.TANTAPULSE_SOURCE_FILTER_KEY,
    sourceRunId: process.env.TANTAPULSE_SOURCE_RUN_ID,
    campaignId: process.env.TANTAPULSE_CAMPAIGN_ID,
    approvalId: process.env.TANTAPULSE_CAMPAIGN_APPROVAL_ID,
    sequenceId: process.env.TANTAPULSE_HUNTER_SEQUENCE_ID,
    senderAccountId: process.env.TANTAPULSE_HUNTER_SENDER_ACCOUNT_ID,
    listId: process.env.TANTAPULSE_HUNTER_LIST_ID,
    hunterApiKey,
    atlasEndpoint: process.env.TANTAPULSE_CRM_ENDPOINT,
    ingestionSecret: process.env.HOLDINGS_INGESTION_SECRET,
    approval,
  };
}

function scoreBands() {
  return String(process.env.TANTAPULSE_SOURCE_SCORE_BANDS || "high,usable").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
}

async function admitCandidate({ candidate, approval, store }) {
  const prospect = normalizeProspect({
    id: candidate.source_candidate_id,
    email: candidate.email,
    first_name: candidate.first_name,
    last_name: candidate.last_name,
    verification: "valid",
    verified_at: candidate.verified_at,
  }, approval.campaign_id);
  if (!prospect) return { admitted: false, reason: "invalid_verified_candidate" };
  const claim = await store.claimEvent({ approvalId: approval.id, eventKey: prospect.event_key, event: prospect.event });
  if (!claim.claimed) {
    const existing = await store.getEvent(prospect.event_key);
    if (existing?.status === "delivered") {
      await store.admitProspect({ approvalId: approval.id, prospect });
      await store.markVerificationAdmitted(candidate.id);
      return { admitted: true, duplicate: true };
    }
    return { admitted: false, reason: "crm_event_not_delivered" };
  }
  const delivery = await postAtlasEvent({ endpoint: process.env.TANTAPULSE_CRM_ENDPOINT, ingestionSecret: process.env.HOLDINGS_INGESTION_SECRET, event: prospect.event });
  await store.completeEvent(prospect.event_key, delivery);
  if (!delivery.ok) return { admitted: false, reason: "crm_delivery_failed", atlas_status: delivery.status };
  await store.admitProspect({ approvalId: approval.id, prospect });
  await store.markVerificationAdmitted(candidate.id);
  return { admitted: true, atlas_status: delivery.status };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.THOS_SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(200).json({ ok: true, mode: "disabled", blocked_by: ["TantaPulse Supabase runtime configuration"] });
  const approvalId = process.env.TANTAPULSE_CAMPAIGN_APPROVAL_ID;
  const hunterApiKey = process.env.HUNTER_IO_API_KEY || process.env.HUNTER_API_KEY;
  const store = createOutboundStore({ supabaseUrl, supabaseKey });
  const approval = approvalId ? await store.getApproval(approvalId) : null;
  const gate = verificationGate(config(approval, hunterApiKey));
  if (!gate.allowed) return res.status(200).json({ ok: true, mode: "disabled", blocked_by: gate.missing });

  try {
    const sourceLeads = await store.listSourceLeads({ runId: process.env.TANTAPULSE_SOURCE_RUN_ID, scoreBands: scoreBands(), limit: 250 });
    for (const lead of sourceLeads) {
      await store.upsertVerificationCandidate({
        approvalId: approval.id,
        sourceFilterKey: process.env.TANTAPULSE_SOURCE_FILTER_KEY,
        source: {
          source_candidate_id: `lead-feed:${lead.id}`,
          email: String(lead.email || "").toLowerCase(),
          source_ref: { lead_feed_id: lead.id, canonical_entity_id: lead.canonical_entity_id || null, score_band: lead.score_band, lead_score: lead.lead_score, city: lead.city || null, niche: lead.niche || null },
        },
      });
    }
    let verificationAttempts = await store.countVerificationAttempts(approval.id);
    let admittedCount = await store.countAdmittedProspects(approval.id);
    const remainingVerifications = Math.max(0, Number(approval.verification_cap) - verificationAttempts);
    const remainingProspects = Math.max(0, Number(approval.prospect_cap) - admittedCount);
    const candidates = remainingVerifications && remainingProspects ? await store.listPendingVerificationCandidates(approval.id, Math.min(50, remainingVerifications, remainingProspects)) : [];
    const results = [];
    for (const candidate of candidates) {
      const claim = await store.claimVerificationCandidate(candidate.id);
      if (!claim) continue;
      try {
        const verification = await verifyHunterEmail({ email: claim.email, apiKey: hunterApiKey });
        const valid = ["valid", "deliverable"].includes(verification.status);
        await store.completeVerificationCandidate(claim.id, { status: valid ? "valid" : "invalid", hunterStatus: verification.status, score: verification.score });
        verificationAttempts += 1;
        if (!valid) {
          results.push({ candidate_id: claim.source_candidate_id, verified: false, status: verification.status });
          continue;
        }
        const admitted = await admitCandidate({ candidate: { ...claim, verified_at: new Date().toISOString() }, approval, store });
        if (admitted.admitted) admittedCount += 1;
        results.push({ candidate_id: claim.source_candidate_id, verified: true, admitted: admitted.admitted, reason: admitted.reason || null });
      } catch (error) {
        await store.completeVerificationCandidate(claim.id, { status: "error", error: error.message });
        results.push({ candidate_id: claim.source_candidate_id, verified: false, error: "verification_failed" });
      }
    }
    await store.recordReceipt({ approval_id: approval.id, mode: "read_only_reconciliation", emitted_count: results.filter((result) => result.admitted).length, detail: { action: "apify_hunter_verification", source_leads_seen: sourceLeads.length, verification_attempts: verificationAttempts, verification_cap: approval.verification_cap, admitted_count: admittedCount, prospect_cap: approval.prospect_cap } });
    return res.status(200).json({ ok: true, mode: "active", source_leads_seen: sourceLeads.length, results });
  } catch (error) {
    return res.status(502).json({ ok: false, error: "source_verification_failed", detail: error.message });
  }
}

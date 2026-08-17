import { campaignGate, normalizeProspect, postAtlasEvent } from "../../lib/outbound-lifecycle.mjs";
import { createOutboundStore } from "../../lib/outbound-store.mjs";

function authorized(req) {
  return Boolean(process.env.CRON_SECRET) && req.headers?.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.THOS_SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(503).json({ error: "Outbound state store is not configured" });
  const approvalId = process.env.TANTAPULSE_CAMPAIGN_APPROVAL_ID;
  const hunterApiKey = process.env.HUNTER_IO_API_KEY || process.env.HUNTER_API_KEY;
  const store = createOutboundStore({ supabaseUrl, supabaseKey });
  const approval = approvalId ? await store.getApproval(approvalId) : null;
  const gate = campaignGate({
    mode: process.env.TANTAPULSE_OUTBOUND_MODE,
    liveReleaseApproved: process.env.TANTAPULSE_LIVE_RELEASE_APPROVED,
    campaignId: process.env.TANTAPULSE_CAMPAIGN_ID,
    approvalId,
    sequenceId: process.env.TANTAPULSE_HUNTER_SEQUENCE_ID,
    senderAccountId: process.env.TANTAPULSE_HUNTER_SENDER_ACCOUNT_ID,
    listId: process.env.TANTAPULSE_HUNTER_LIST_ID,
    hunterApiKey,
    atlasEndpoint: process.env.TANTAPULSE_CRM_ENDPOINT,
    ingestionSecret: process.env.HOLDINGS_INGESTION_SECRET,
    approval,
  });
  if (!gate.allowed) return res.status(409).json({ error: "campaign_not_released", blocked_by: gate.missing });
  if (String(body.list_id || "") !== String(approval.approved_list_id || "")) return res.status(409).json({ error: "unapproved_list" });
  const candidates = Array.isArray(body.prospects) ? body.prospects : [];
  const results = [];
  let admittedCount = await store.countAdmittedProspects(approval.id);
  const estimatedCostPerProspect = Number(approval.estimated_variable_cost_per_prospect_cents);
  const costCap = Number(approval.variable_cost_cap_cents);
  for (const candidate of candidates) {
    if (admittedCount >= approval.prospect_cap) {
      results.push({ admitted: false, reason: "prospect_cap_reached" });
      continue;
    }
    if ((admittedCount + 1) * estimatedCostPerProspect > costCap) {
      results.push({ admitted: false, reason: "variable_cost_cap_reached", reserved_variable_cost_cents: admittedCount * estimatedCostPerProspect, variable_cost_cap_cents: costCap });
      continue;
    }
    const prospect = normalizeProspect(candidate, approval.campaign_id);
    if (!prospect) {
      results.push({ admitted: false, reason: "invalid_or_unverified_prospect" });
      continue;
    }
    const claim = await store.claimEvent({ approvalId: approval.id, eventKey: prospect.event_key, event: prospect.event });
    if (!claim.claimed) {
      results.push({ prospect_id: prospect.event.prospect_id, admitted: false, duplicate: true });
      continue;
    }
    const delivery = await postAtlasEvent({ endpoint: process.env.TANTAPULSE_CRM_ENDPOINT, ingestionSecret: process.env.HOLDINGS_INGESTION_SECRET, event: prospect.event });
    await store.completeEvent(prospect.event_key, delivery);
    if (delivery.ok) {
      await store.admitProspect({ approvalId: approval.id, prospect });
      admittedCount += 1;
    }
    results.push({ prospect_id: prospect.event.prospect_id, admitted: delivery.ok, atlas_status: delivery.status });
  }
  await store.recordReceipt({ approval_id: approval.id, mode: "read_only_reconciliation", emitted_count: results.filter((row) => row.admitted).length, detail: { admission_count: candidates.length, list_id: approval.approved_list_id, reserved_variable_cost_cents: admittedCount * estimatedCostPerProspect, variable_cost_cap_cents: costCap } });
  return res.status(200).json({ ok: true, results });
}

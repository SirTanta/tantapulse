import { addHunterSequenceRecipients, recipientEnrollmentGate } from "../../lib/outbound-lifecycle.mjs";
import { createOutboundStore } from "../../lib/outbound-store.mjs";

function authorized(req) {
  return Boolean(process.env.CRON_SECRET) && req.headers?.authorization === `Bearer ${process.env.CRON_SECRET}`;
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
  const gate = recipientEnrollmentGate({
    mode: process.env.TANTAPULSE_OUTBOUND_MODE,
    liveReleaseApproved: process.env.TANTAPULSE_LIVE_RELEASE_APPROVED,
    recipientEnrollmentApproved: process.env.TANTAPULSE_HUNTER_RECIPIENT_ENROLLMENT_APPROVED,
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
  if (!gate.allowed) return res.status(200).json({ ok: true, mode: "disabled", blocked_by: gate.missing });
  try {
    const prospects = await store.listUnenrolledProspects(approval.id, 50);
    if (!prospects.length) return res.status(200).json({ ok: true, mode: "active", enrolled: 0, note: "No approved prospects pending enrollment" });
    const result = await addHunterSequenceRecipients({ sequenceId: process.env.TANTAPULSE_HUNTER_SEQUENCE_ID, emails: prospects.map((prospect) => prospect.email), apiKey: hunterApiKey });
    const skipped = new Set(result.skipped.map((entry) => entry.email));
    const enrolled = prospects.filter((prospect) => !skipped.has(String(prospect.email).toLowerCase()));
    await store.markProspectsEnrolled(approval.id, enrolled.map((prospect) => prospect.hunter_prospect_id));
    await store.recordReceipt({ approval_id: approval.id, mode: "read_only_reconciliation", emitted_count: enrolled.length, detail: { action: "hunter_recipient_enrollment", added: result.added, skipped_count: result.skipped.length } });
    return res.status(200).json({ ok: true, mode: "active", enrolled: enrolled.length, skipped: result.skipped.length });
  } catch (error) {
    return res.status(502).json({ ok: false, error: "hunter_recipient_enrollment_failed", detail: error.message });
  }
}

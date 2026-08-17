import { campaignGate, recipientEnrollmentGate, verificationGate } from "../../lib/outbound-lifecycle.mjs";
import { createOutboundStore } from "../../lib/outbound-store.mjs";

function authorized(req) {
  return Boolean(process.env.CRON_SECRET) && req.headers?.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

function runtimeConfig(approval) {
  return {
    mode: process.env.TANTAPULSE_OUTBOUND_MODE,
    liveReleaseApproved: process.env.TANTAPULSE_LIVE_RELEASE_APPROVED,
    verificationApproved: process.env.TANTAPULSE_HUNTER_VERIFICATION_APPROVED,
    recipientEnrollmentApproved: process.env.TANTAPULSE_HUNTER_RECIPIENT_ENROLLMENT_APPROVED,
    sourceFilterKey: process.env.TANTAPULSE_SOURCE_FILTER_KEY,
    sourceRunId: process.env.TANTAPULSE_SOURCE_RUN_ID,
    campaignId: process.env.TANTAPULSE_CAMPAIGN_ID,
    approvalId: process.env.TANTAPULSE_CAMPAIGN_APPROVAL_ID,
    sequenceId: process.env.TANTAPULSE_HUNTER_SEQUENCE_ID,
    senderAccountId: process.env.TANTAPULSE_HUNTER_SENDER_ACCOUNT_ID,
    listId: process.env.TANTAPULSE_HUNTER_LIST_ID,
    hunterApiKey: process.env.HUNTER_IO_API_KEY || process.env.HUNTER_API_KEY,
    atlasEndpoint: process.env.TANTAPULSE_CRM_ENDPOINT,
    ingestionSecret: process.env.HOLDINGS_INGESTION_SECRET,
    approval,
  };
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
  try {
    const store = createOutboundStore({ supabaseUrl, supabaseKey });
    const approval = approvalId ? await store.getApproval(approvalId) : null;
    const config = runtimeConfig(approval);
    const campaign = campaignGate(config);
    const verification = verificationGate(config);
    const enrollment = recipientEnrollmentGate(config);
    return res.status(200).json({
      ok: true,
      mode: "preflight",
      campaign: { allowed: campaign.allowed, blocked_by: campaign.missing },
      verification: { allowed: verification.allowed, blocked_by: verification.missing },
      enrollment: { allowed: enrollment.allowed, blocked_by: enrollment.missing },
      approval: approval ? { campaign_id: approval.campaign_id, status: approval.status, expires_at: approval.expires_at || null } : null,
    });
  } catch (error) {
    return res.status(502).json({ ok: false, error: "outbound_preflight_failed", detail: error.message });
  }
}

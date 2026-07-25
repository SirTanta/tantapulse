import { campaignGate, senderHealth } from "../../lib/outbound-lifecycle.mjs";
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
    hunterApiKey: process.env.HUNTER_API_KEY,
    atlasEndpoint: process.env.TANTAPULSE_CRM_ENDPOINT,
    ingestionSecret: process.env.HOLDINGS_INGESTION_SECRET,
    approval,
  });
  if (!gate.allowed) {
    await store.recordReceipt({ approval_id: approval?.id || null, mode: "disabled", detail: { blocked_by: gate.missing } });
    return res.status(200).json({ ok: true, mode: "disabled", blocked_by: gate.missing });
  }
  try {
    const health = await senderHealth({ senderAccountId: process.env.TANTAPULSE_HUNTER_SENDER_ACCOUNT_ID, apiKey: process.env.HUNTER_API_KEY });
    await store.recordReceipt({ approval_id: approval.id, mode: "read_only_health", sender_status: health.sender_status, detail: { ready: health.ready, warmup_status: health.warmup_status, daily_limit: health.daily_limit } });
    return res.status(200).json({ ok: true, mode: "read_only", health });
  } catch (error) {
    return res.status(502).json({ ok: false, error: "hunter_health_read_failed", detail: error.message });
  }
}

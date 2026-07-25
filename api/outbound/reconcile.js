import { campaignGate, listHunterMessages, normalizeHunterMessage, postAtlasEvent, senderHealth, toStageChangedEvent } from "../../lib/outbound-lifecycle.mjs";
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
  if (!gate.allowed) {
    await store.recordReceipt({ approval_id: approval?.id || null, mode: "disabled", detail: { blocked_by: gate.missing } });
    return res.status(200).json({ ok: true, mode: "disabled", blocked_by: gate.missing });
  }
  try {
    const health = await senderHealth({ senderAccountId: process.env.TANTAPULSE_HUNTER_SENDER_ACCOUNT_ID, apiKey: hunterApiKey });
    if (!health.ready) return res.status(409).json({ ok: false, error: "sender_not_ready", health });
    const messages = await listHunterMessages({ sequenceId: process.env.TANTAPULSE_HUNTER_SEQUENCE_ID, apiKey: hunterApiKey });
    const normalized = messages.map(normalizeHunterMessage).filter(Boolean);
    const admitted = await store.listAdmittedProspects(approval.id, [...new Set(normalized.map((message) => message.prospect_id))]);
    const events = normalized.filter((message) => admitted.has(message.prospect_id)).map(toStageChangedEvent);
    const results = [];
    for (const { event_key, event } of events) {
      const claim = await store.claimEvent({ approvalId: approval.id, eventKey: event_key, event });
      if (!claim.claimed) {
        results.push({ event_key, event_id: event.event_id, lifecycle_stage: event.lifecycle_stage, duplicate: true });
        continue;
      }
      const delivered = await postAtlasEvent({ endpoint: process.env.TANTAPULSE_CRM_ENDPOINT, ingestionSecret: process.env.HOLDINGS_INGESTION_SECRET, event });
      await store.completeEvent(event_key, delivered);
      results.push({ event_key, event_id: event.event_id, lifecycle_stage: event.lifecycle_stage, atlas_status: delivered.status, delivered: delivered.ok });
      if (!delivered.ok && !delivered.retryable) break;
    }
    await store.recordReceipt({ approval_id: approval.id, mode: "read_only_reconciliation", message_count: messages.length, emitted_count: events.length, skipped_unadmitted_count: normalized.length - events.length, sender_status: health.sender_status, detail: { ready: health.ready } });
    return res.status(200).json({ ok: true, mode: "read_only_reconciliation", message_count: messages.length, results });
  } catch (error) {
    return res.status(502).json({ ok: false, error: "outbound_reconciliation_failed", detail: error.message });
  }
}

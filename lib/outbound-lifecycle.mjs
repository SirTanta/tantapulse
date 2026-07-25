import crypto from "node:crypto";

const HUNTER_BASE_URL = "https://api.hunter.io/v2";
const LIVE_MODE = "live";

function text(value) {
  return String(value ?? "").trim();
}

function truthy(value) {
  return ["1", "true", "yes"].includes(text(value).toLowerCase());
}

function timestamp(value, fallback = new Date().toISOString()) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? fallback : parsed.toISOString();
}

export function stableUuid(value) {
  const hex = crypto.createHash("sha256").update(text(value)).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function hmacSignature(body, secret) {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function campaignGate(config = {}, now = new Date()) {
  const missing = [];
  if (config.mode !== LIVE_MODE) missing.push("TANTAPULSE_OUTBOUND_MODE=live");
  if (!truthy(config.liveReleaseApproved)) missing.push("TANTAPULSE_LIVE_RELEASE_APPROVED=true");
  if (!text(config.campaignId)) missing.push("TANTAPULSE_CAMPAIGN_ID");
  if (!text(config.approvalId)) missing.push("TANTAPULSE_CAMPAIGN_APPROVAL_ID");
  if (!text(config.sequenceId)) missing.push("TANTAPULSE_HUNTER_SEQUENCE_ID");
  if (!text(config.senderAccountId)) missing.push("TANTAPULSE_HUNTER_SENDER_ACCOUNT_ID");
  if (!text(config.listId)) missing.push("TANTAPULSE_HUNTER_LIST_ID");
  if (!text(config.hunterApiKey)) missing.push("HUNTER_API_KEY");
  if (!text(config.atlasEndpoint)) missing.push("TANTAPULSE_CRM_ENDPOINT");
  if (!text(config.ingestionSecret)) missing.push("HOLDINGS_INGESTION_SECRET");
  if (config.approval?.status !== "approved") missing.push("approved Atlas campaign record");
  if (config.approval?.campaign_id !== config.campaignId) missing.push("matching approved campaign record");
  if (config.approval?.sequence_id && String(config.approval.sequence_id) !== String(config.sequenceId)) missing.push("matching approved Hunter sequence");
  if (config.approval?.sender_account_id && String(config.approval.sender_account_id) !== String(config.senderAccountId)) missing.push("matching approved Hunter sender");
  if (config.approval?.approved_list_id && String(config.approval.approved_list_id) !== String(config.listId)) missing.push("matching approved Hunter list");
  if (config.approval?.expires_at && new Date(config.approval.expires_at) <= now) missing.push("unexpired campaign approval");
  return { allowed: missing.length === 0, missing };
}

export function normalizeProspect(prospect = {}, campaignId) {
  const hunterProspectId = text(prospect.hunter_prospect_id || prospect.prospect_id || prospect.id || prospect.lead_id);
  const verification = text(prospect.verification_status || prospect.verification || prospect.status).toLowerCase();
  const valid = ["valid", "deliverable"].includes(verification);
  if (!hunterProspectId || !valid || !text(prospect.email) || !text(campaignId)) return null;
  const eventKey = `hunter:prospect:${hunterProspectId}:verified`;
  return {
    event_key: eventKey,
    event: {
      event_id: stableUuid(eventKey),
      event_type: "prospect.verified",
      occurred_at: timestamp(prospect.verified_at || prospect.updated_at || prospect.created_at),
      prospect_id: hunterProspectId,
      lifecycle_stage: "new",
      prospect: {
        first_name: text(prospect.first_name) || undefined,
        last_name: text(prospect.last_name) || undefined,
        email: text(prospect.email).toLowerCase(),
        source: "hunter",
        utm_source: "hunter",
        utm_medium: "outbound",
        utm_campaign: campaignId,
      },
    },
  };
}

export function normalizeHunterMessage(message = {}) {
  const hunterProspectId = text(message.lead?.id || message.lead_id || message.prospect_id);
  const messageId = text(message.id || message.message_id);
  if (!hunterProspectId || !messageId) return null;
  const status = text(message.status).toLowerCase();
  const optedOut = status === "unsubscribed" || message.unsubscribed === true;
  const bounced = status === "bounced" || message.bounced === true;
  const replied = ["replied", "reply"].includes(status) || message.replied === true;
  const lifecycleStage = optedOut ? "opt_out" : bounced ? "bounced" : replied ? "interested" : "contacted";
  const eventKey = `hunter:message:${messageId}:${lifecycleStage}`;
  return {
    event_key: eventKey,
    prospect_id: hunterProspectId,
    lifecycle_stage: lifecycleStage,
    occurred_at: timestamp(message.last_activity_at || message.sent_at),
    message_id: messageId,
    thread_id: text(message.thread_id) || null,
    reason: optedOut ? "hunter opt-out" : bounced ? "hunter bounce" : replied ? "hunter meaningful reply pending review" : "approved outreach sent",
  };
}

export function toStageChangedEvent(message) {
  return {
    event_key: message.event_key,
    event: {
      event_id: stableUuid(message.event_key),
      event_type: "prospect.stage_changed",
      occurred_at: message.occurred_at,
      prospect_id: message.prospect_id,
      lifecycle_stage: message.lifecycle_stage,
      reason: message.reason,
    },
  };
}

export async function postAtlasEvent({ endpoint, ingestionSecret, event, fetchImpl = fetch }) {
  const body = JSON.stringify(event);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tanta-Signature": hmacSignature(body, ingestionSecret),
    },
    body,
  });
  const responseBody = await response.text();
  if (response.status === 200 || response.status === 202) return { ok: true, status: response.status };
  const retryable = response.status === 429 || response.status >= 500;
  return { ok: false, status: response.status, retryable, error: `atlas_${response.status}:${responseBody.slice(0, 160)}` };
}

export async function hunterGet({ path, apiKey, fetchImpl = fetch }) {
  const url = new URL(`${HUNTER_BASE_URL}${path}`);
  url.searchParams.set("api_key", apiKey);
  const response = await fetchImpl(url, { method: "GET" });
  const raw = await response.text();
  let json;
  try { json = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`Hunter returned invalid JSON for ${path}`); }
  if (!response.ok) throw new Error(`Hunter read failed for ${path}: ${response.status}`);
  return json;
}

export async function listHunterMessages({ sequenceId, apiKey, fetchImpl = fetch, limit = 100, maxPages = 20 }) {
  const messages = [];
  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * limit;
    const payload = await hunterGet({ path: `/messages?sequence_id=${encodeURIComponent(sequenceId)}&limit=${limit}&offset=${offset}`, apiKey, fetchImpl });
    const pageItems = Array.isArray(payload.data?.messages) ? payload.data.messages : [];
    messages.push(...pageItems);
    if (pageItems.length < limit) break;
  }
  return messages;
}

export async function senderHealth({ senderAccountId, apiKey, fetchImpl = fetch }) {
  const [account, capacity] = await Promise.all([
    hunterGet({ path: `/email-accounts/${encodeURIComponent(senderAccountId)}`, apiKey, fetchImpl }),
    hunterGet({ path: `/email-accounts/${encodeURIComponent(senderAccountId)}/usage`, apiKey, fetchImpl }),
  ]);
  const sender = account.data || {};
  const health = {
    sender_status: text(sender.sending_status || sender.status).toLowerCase(),
    warmup_status: text(sender.warmup?.status).toLowerCase(),
    daily_limit: Number(sender.daily_limit || 0),
    capacity: capacity.data || {},
  };
  health.ready = health.sender_status === "active" && !["warming", "paused"].includes(health.warmup_status);
  return health;
}

export function makeNoSendReceipt({ campaignId, fixtures = [], now = new Date() }) {
  const planned = fixtures.map((fixture) => {
    if (fixture.kind === "prospect") return normalizeProspect(fixture, campaignId);
    const normalized = normalizeHunterMessage(fixture);
    return normalized ? toStageChangedEvent(normalized) : null;
  }).filter(Boolean);
  return {
    mode: "no_send",
    run_timestamp_utc: now.toISOString(),
    campaign_id: campaignId || null,
    fixture_count: fixtures.length,
    planned_event_count: planned.length,
    events: planned.map(({ event_key, event }) => ({ event_key, event_type: event.event_type, event_id: event.event_id, prospect_id: event.prospect_id, lifecycle_stage: event.lifecycle_stage || event.prospect?.lifecycle_stage })),
  };
}

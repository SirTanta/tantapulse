/**
 * Lane 2 — processor handler
 * GET|POST /api/lane2/process
 *
 * Mirrors the TantaPulse lead-feed/process.js architecture:
 *   1. Poll lane2_feed_runs for status='queued' rows
 *   2. For each queued run: fetch Apify dataset items, normalize + score + dedupe,
 *      then persist to lane2_raw_items and lane2_leads
 *   3. Enqueue high-scoring leads in lane2_followup_queue
 *
 * Manual mode (POST with `items` array) is supported for testing.
 *
 * Env vars:
 *   THOS_SUPABASE_URL, THOS_SUPABASE_SERVICE_KEY
 *   APIFY_TOKEN
 *   LANE2_APIFY_MAX_ITEMS   — max dataset fetch size (default 1000)
 *   LANE2_SCORE_MIN_ACTION  — minimum score_band to enqueue (default 'usable')
 *   LANE2_LEAD_SCORE_CAP    — minimum lead_score to queue for follow-up (default 50)
 */

import crypto from "node:crypto";

// ── Inline helpers (identical to tantapulse-pipeline.mjs, duplicated here
//    to keep the handler self-contained without a module system) ───────────

const WORD_CLEANUP = /[^a-z0-9\s.-]/gi;
const MULTISPACE   = /\s+/g;

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(MULTISPACE, " ")
    .trim();
}

function normalizeDomain(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return "";
  try {
    const url = text.startsWith("http")
      ? new URL(text)
      : new URL(`https://${text}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return text.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split(":")[0];
  }
}

function normalizePhone(value) {
  const raw = normalizeText(value).replace(/[^\d+]/g, "");
  if (!raw) return "";
  if (raw.startsWith("+")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return digits;
}

function sha1(input) {
  return crypto.createHash("sha1").update(String(input ?? "")).digest("hex");
}

function stableGroupId(...parts) {
  return sha1(parts.filter(Boolean).join("|")).slice(0, 16);
}

// ── Scoring ────────────────────────────────────────────────────────────────

function scoreFit(record, context) {
  let score = 0;
  const reasons = [];
  if (record.business_name) { score += 10; reasons.push("has_name"); }
  if (record.website)        { score += 20; reasons.push("has_website"); }
  if (record.phone)          { score += 10; reasons.push("has_phone"); }
  if (record.email)          { score += 10; reasons.push("has_email"); }
  if (record.city)           { score += 10; reasons.push("has_city"); }
  if (record.niche)          { score += 10; reasons.push("has_niche"); }
  const searchText = `${record.business_name} ${record.niche} ${record.city} ${record.website} ${context.niche} ${context.city}`.toLowerCase();
  if (context.niche && searchText.includes(String(context.niche).toLowerCase())) {
    score += 15; reasons.push("matches_niche");
  }
  if (context.city && searchText.includes(String(context.city).toLowerCase())) {
    score += 15; reasons.push("matches_city");
  }
  return { score: clamp(score), reasons };
}

function scoreIntent(record) {
  let score = 0;
  const reasons = [];
  const positives = [
    [record.hiring_intent,        15, "hiring_intent"],
    [record.recent_activity,      10, "recent_activity"],
    [record.review_velocity,        8, "review_velocity"],
    [record.pricing_signal,         8, "pricing_signal"],
    [record.social_proof_signal,     8, "social_proof_signal"],
    [record.trigger_event,          12, "trigger_event"],
  ];
  for (const [flag, points, reason] of positives) {
    if (flag) { score += points; reasons.push(reason); }
  }
  const signalText = `${record.title} ${record.description} ${record.notes}`.toLowerCase();
  if (/hiring|growth|expanding|opening|campaign|new location|request a quote/.test(signalText)) {
    score += 12; reasons.push("intent_keywords");
  }
  return { score: clamp(score), reasons };
}

function scoreQuality(record) {
  let score = 0;
  const reasons = [];
  const fields = [
    record.business_name, record.website, record.phone,
    record.email, record.city, record.source_url, record.collected_at,
  ];
  score += fields.filter(Boolean).length * 8;
  if (record.source_confidence)    { score += 8; reasons.push("source_confidence"); }
  if (record.extraction_confidence){ score += 8; reasons.push("extraction_confidence"); }
  if (Number.isFinite(record.freshness_hours)) {
    if (record.freshness_hours <= 24)  { score += 12; reasons.push("fresh_24h"); }
    else if (record.freshness_hours <= 72) { score += 6; reasons.push("fresh_72h"); }
  }
  return { score: clamp(score), reasons };
}

function scoreEngagement(record) {
  let score = 0;
  const reasons = [];
  if (Number(record.reviews_count || 0) >= 20) { score += 8; reasons.push("review_volume"); }
  if (Number(record.rating || 0) >= 4.2)     { score += 6; reasons.push("strong_rating"); }
  if (Number(record.employee_count || 0) >= 5){ score += 4; reasons.push("team_size"); }
  if (record.previous_response || record.reply_count || record.engagement_signal) {
    score += 12; reasons.push("engagement_signal");
  }
  return { score: clamp(score), reasons };
}

function normalizeLead(item = {}, context = {}) {
  const raw = item.raw ?? item;
  const website = normalizeDomain(raw.website || raw.domain || raw.url || raw.source_url);
  return {
    business_name:       normalizeText(raw.business_name || raw.company_name || raw.name || raw.title),
    niche:               normalizeText(raw.niche || raw.category || context.niche || "HVAC"),
    city:                normalizeText(raw.city || raw.location || context.city || "Austin"),
    state:               normalizeText(raw.state || raw.region || "TX"),
    website,
    phone:               normalizePhone(raw.phone || raw.telephone || raw.contact_phone),
    email:               normalizeText(raw.email || raw.contact_email).toLowerCase(),
    source_url:          normalizeText(raw.source_url || raw.url || raw.link || ""),
    collected_at:        raw.collected_at || raw.timestamp || context.collectedAt || new Date().toISOString(),
    source:              "apify",
    title:               normalizeText(raw.title || ""),
    description:         normalizeText(raw.description || raw.summary || ""),
    rating:              Number.isFinite(Number(raw.rating)) ? Number(raw.rating) : null,
    reviews_count:       Number.isFinite(Number(raw.reviews_count || raw.reviewCount))
                          ? Number(raw.reviews_count || raw.reviewCount) : null,
    employee_count:      Number.isFinite(Number(raw.employee_count)) ? Number(raw.employee_count) : null,
    source_confidence:   Number.isFinite(Number(raw.source_confidence)) ? Number(raw.source_confidence) : null,
    extraction_confidence: Number.isFinite(Number(raw.extraction_confidence)) ? Number(raw.extraction_confidence) : null,
    freshness_hours:     Number.isFinite(Number(raw.freshness_hours)) ? Number(raw.freshness_hours) : null,
    // Intent signals — for HVAC these are derived in enrichHvacItem
    hiring_intent:       Boolean(raw.hiring_intent),
    recent_activity:      Boolean(raw.recent_activity),
    review_velocity:     Boolean(raw.review_velocity),
    pricing_signal:      Boolean(raw.pricing_signal),
    social_proof_signal: Boolean(raw.social_proof_signal),
    trigger_event:       Boolean(raw.trigger_event),
    previous_response:   Boolean(raw.previous_response),
    reply_count:         Number.isFinite(Number(raw.reply_count)) ? Number(raw.reply_count) : 0,
    engagement_signal:   Boolean(raw.engagement_signal),
    // HVAC-specific fields
    hvac_type:           raw.hvac_type || "both",
    emergency_service:    Boolean(raw.emergency_service),
    services:             Array.isArray(raw.services) ? raw.services : [],
    serving_zips:         Array.isArray(raw.serving_zips) ? raw.serving_zips : [],
    years_in_business:   Number.isFinite(Number(raw.years_in_business)) ? Number(raw.years_in_business) : null,
    licensing_info:      normalizeText(raw.licensing_info || ""),
    insurance_verified:  Boolean(raw.insurance_verified),
  };
}

function scoreLead(record, context = {}) {
  const fit        = scoreFit(record, context);
  const intent     = scoreIntent(record);
  const quality    = scoreQuality(record);
  const engagement = scoreEngagement(record);
  const score = clamp(Math.round(
    (fit.score * 0.45) + (intent.score * 0.30) + (quality.score * 0.15) + (engagement.score * 0.10)
  ));
  const band   = score >= 80 ? "high" : score >= 50 ? "usable" : "low";
  const action = score >= 80 ? "send_first" : score >= 50 ? "keep" : "hold";
  const reasons = [...new Set([...fit.reasons, ...intent.reasons, ...quality.reasons, ...engagement.reasons])];
  return {
    lead_score: score,
    score_band: band,
    recommended_action: action,
    score_breakdown: { fit: fit.score, intent: intent.score, quality: quality.score, engagement: engagement.score },
    score_reasons: reasons,
  };
}

function processBatch(items = [], context = {}) {
  const normalized = items.map((item) => {
    const record = normalizeLead(item, context);
    const scoring = scoreLead(record, context);
    const dupGroupId = stableGroupId(
      record.business_name,
      record.website || record.phone || record.email || record.fingerprint,
      record.city || context.city || ""
    );
    return {
      ...record,
      ...scoring,
      duplicate_group_id:  dupGroupId,
      canonical_entity_id: dupGroupId,
      raw_item_hash:       sha1(JSON.stringify(item || {})),
    };
  });

  const deduped = new Map();
  for (const record of normalized) {
    const current = deduped.get(record.duplicate_group_id);
    if (!current || record.lead_score > current.lead_score) {
      deduped.set(record.duplicate_group_id, record);
    }
  }

  const kept = [...deduped.values()].sort((a, b) => b.lead_score - a.lead_score);
  const counts = {
    total:           normalized.length,
    unique:          kept.length,
    high:            normalized.filter((r) => r.score_band === "high").length,
    usable:          normalized.filter((r) => r.score_band === "usable").length,
    low:             normalized.filter((r) => r.score_band === "low").length,
    duplicate_rate:  normalized.length
      ? Number(((normalized.length - kept.length) / normalized.length).toFixed(3))
      : 0,
    average_score: normalized.length
      ? Number((normalized.reduce((s, r) => s + Number(r.lead_score || 0), 0) / normalized.length).toFixed(1))
      : 0,
  };

  return {
    context,
    counts,
    items: normalized,
    unique_items: kept,
    top_items:    kept.slice(0, 10),
    routing: {
      instant_alert: kept.filter((r) => r.lead_score >= 80).length,
      nurture:       kept.filter((r) => r.lead_score >= 50 && r.lead_score < 80).length,
      hold:          kept.filter((r) => r.lead_score < 50).length,
    },
  };
}

// ── Supabase helpers ───────────────────────────────────────────────────────

async function apiGet(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* noop */ }
  return { ok: res.ok, status: res.status, text, json };
}

async function apiSend(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* noop */ }
  return { ok: res.ok, status: res.status, text, json };
}

async function apiPatch(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function fetchQueuedRuns({ supabaseUrl, supabaseKey }) {
  const qs = new URLSearchParams({
    select: "*",
    status: "eq.queued",
    order:  "requested_at.asc",
    limit:  "25",
  });
  return apiGet(
    `${supabaseUrl}/rest/v1/lane2_feed_runs?${qs}`,
    { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }
  );
}

async function fetchApifyDataset(datasetId, token, limit = 1000) {
  const url = new URL(`https://api.apify.com/v2/datasets/${datasetId}/items`);
  url.searchParams.set("clean", "true");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("token", token);
  const res = await fetch(url.toString());
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* noop */ }
  return { ok: res.ok, status: res.status, text, json };
}

async function persistBatch(run, batch, sourceLabel = "queued", { supabaseUrl, supabaseKey }) {
  if (!supabaseUrl || !supabaseKey) return { persisted: false, reason: "missing_supabase_env" };
  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    Prefer: "resolution=merge-duplicates,return=minimal",
  };

  const rawRows = batch.items.map((row) => ({
    run_id:           run.id,
    apify_run_id:     run.apify_run_id,
    apify_dataset_id: run.apify_dataset_id,
    payload:          row.raw ?? row,
    payload_hash:     row.raw_item_hash,
    collected_at:     row.collected_at,
  }));

  const leadRows = batch.items.map((row) => ({
    run_id:              run.id,
    canonical_entity_id:  row.canonical_entity_id,
    duplicate_group_id:  row.duplicate_group_id,
    business_name:       row.business_name,
    niche:               row.niche,
    city:                row.city,
    state:               row.state,
    website:             row.website,
    phone:               row.phone,
    email:               row.email,
    source:              row.source,
    source_url:          row.source_url,
    collected_at:        row.collected_at,
    lead_score:          row.lead_score,
    score_band:          row.score_band,
    recommended_action:  row.recommended_action,
    score_breakdown:    row.score_breakdown,
    score_reasons:      row.score_reasons,
    source_confidence:    row.source_confidence,
    extraction_confidence: row.extraction_confidence,
    hvac_type:           row.hvac_type,
    emergency_service:   row.emergency_service,
    services:            row.services,
    serving_zips:        row.serving_zips,
    years_in_business:   row.years_in_business,
    licensing_info:      row.licensing_info,
    insurance_verified:  row.insurance_verified,
  }));

  const followupRows = batch.unique_items
    .filter((row) => row.lead_score >= Number(process.env.LANE2_LEAD_SCORE_CAP ?? "50"))
    .filter((row) => row.email)
    .slice(0, 20)
    .map((row, i) => ({
      run_id: run.id,
      lead_id:   null,  // populated after lead insert if needed
      email:     row.email,
      business_name: row.business_name,
      step:      0,
      scheduled_for: new Date(Date.now() + i * 60 * 1000).toISOString(),
      status:    "pending",
    }));

  const rawInsert    = rawRows.length
    ? await apiSend(`${supabaseUrl}/rest/v1/lane2_raw_items?on_conflict=payload_hash`, rawRows, headers)
    : { ok: true, status: 204 };
  const leadInsert   = leadRows.length
    ? await apiSend(`${supabaseUrl}/rest/v1/lane2_leads?on_conflict=run_id,canonical_entity_id`, leadRows, headers)
    : { ok: true, status: 204 };
  const followInsert = followupRows.length
    ? await apiSend(`${supabaseUrl}/rest/v1/lane2_followup_queue`, followupRows, headers)
    : { ok: true, status: 204 };
  const summaryPatch = run.id
    ? await apiPatch(
        `${supabaseUrl}/rest/v1/lane2_feed_runs?id=eq.${encodeURIComponent(run.id)}`,
        {
          status:        "processed",
          processed_at:  new Date().toISOString(),
          total_count:   batch.counts.total,
          unique_count:  batch.counts.unique,
          high_count:    batch.counts.high,
          usable_count:  batch.counts.usable,
          duplicate_rate: batch.counts.duplicate_rate,
          summary: {
            counts:   batch.counts,
            routing:  batch.routing,
            top_items: batch.top_items.slice(0, 3).map((r) => ({
              business_name:       r.business_name,
              city:                r.city,
              website:             r.website,
              lead_score:         r.lead_score,
              score_band:         r.score_band,
              recommended_action: r.recommended_action,
            })),
          },
        },
        headers
      )
    : { ok: true, status: 204 };

  return {
    persisted:     Boolean(rawInsert.ok && leadInsert.ok && summaryPatch.ok),
    rawInsert:     { ok: rawInsert.ok, status: rawInsert.status },
    leadInsert:    { ok: leadInsert.ok, status: leadInsert.status },
    followInsert:  { ok: followInsert.ok, status: followInsert.status },
    summaryPatch:  { ok: summaryPatch.ok, status: summaryPatch.status },
    enqueued:      followupRows.length,
  };
}

// ── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.THOS_SUPABASE_SERVICE_KEY;
    const apifyToken  = process.env.APIFY_TOKEN;

    // ── Manual / test mode ──────────────────────────────────────────────
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const manualItems = Array.isArray(body.items) ? body.items : [];
      if (!manualItems.length) {
        return res.status(200).json({ ok: true, mode: "idle", note: "No items provided" });
      }
      const context = {
        niche:       normalizeText(body.niche || "HVAC"),
        city:        normalizeText(body.city || "Austin"),
        source:      "manual",
        collectedAt: body.collectedAt || new Date().toISOString(),
      };
      const batch = processBatch(manualItems, context);
      const run = { id: body.run_id || null, apify_run_id: null, apify_dataset_id: null };
      const persisted = supabaseUrl && supabaseKey
        ? await persistBatch(run, batch, "manual", { supabaseUrl, supabaseKey })
        : { persisted: false, reason: "no_supabase" };
      return res.status(200).json({
        ok: true, mode: "manual",
        summary: batch.counts,
        routing: batch.routing,
        persisted,
      });
    }

    // ── Queue mode ──────────────────────────────────────────────────────
    if (!supabaseUrl || !supabaseKey) {
      return res.status(200).json({ ok: true, mode: "idle", note: "No Supabase configured" });
    }

    const queued = await fetchQueuedRuns({ supabaseUrl, supabaseKey });
    if (!queued.ok) {
      return res.status(200).json({
        ok: true, mode: "idle",
        note: "Queue query failed", status: queued.status,
      });
    }

    const runs = Array.isArray(queued.json) ? queued.json : [];
    if (!runs.length) {
      return res.status(200).json({ ok: true, mode: "idle", note: "No queued runs" });
    }

    const outputs = [];
    for (const run of runs) {
      const datasetId = run.apify_dataset_id || null;
      const maxItems = Number(process.env.LANE2_APIFY_MAX_ITEMS ?? "1000");

      let items = Array.isArray(run.sample_items) ? run.sample_items : [];
      if (!items.length && datasetId && apifyToken) {
        const dataset = await fetchApifyDataset(datasetId, apifyToken, maxItems);
        if (dataset.ok && Array.isArray(dataset.json)) items = dataset.json;
        else {
          console.error(`[Lane2 Process] dataset fetch failed for run ${run.id}:`, dataset.status);
          continue;
        }
      }
      if (!items.length) {
        console.warn(`[Lane2 Process] no items for run ${run.id}`);
        continue;
      }

      const context = {
        niche:       run.niche || "HVAC",
        city:        run.city || "Austin",
        source:      run.source || "apify",
        collectedAt: run.requested_at || new Date().toISOString(),
      };
      const batch = processBatch(items, context);
      const persisted = await persistBatch(run, batch, "queued", { supabaseUrl, supabaseKey });
      outputs.push({
        run_id:   run.id,
        counts:   batch.counts,
        routing:  batch.routing,
        persisted,
      });
    }

    return res.status(200).json({ ok: true, mode: "queue", processed: outputs.length, outputs });
  } catch (err) {
    console.error("[Lane2 Process] handler failed:", err);
    return res.status(200).json({ ok: false, mode: "error", error: err.message });
  }
}

/**
 * Lane 3 — Job Boards Processor
 * GET|POST /api/lane3/process
 *
 * Polls lane3_feed_runs for status='queued' rows, fetches Apify datasets,
 * normalizes job records via the field maps, scores each job, dedupes,
 * and persists to lane3_raw_items + lane3_leads.
 *
 * POST mode accepts manual items for testing.
 *
 * Env vars:
 *   THOS_SUPABASE_URL, THOS_SUPABASE_SERVICE_KEY
 *   APIFY_TOKEN
 *   LANE3_APIFY_MAX_ITEMS      — max dataset fetch size (default 1000)
 *   LANE3_LEAD_SCORE_CAP       — min lead_score to enqueue (default 50)
 *
 * The scoring model is adapted for job-board signals:
 *   - Fit (40%): company_name, job_title, keyword match, location
 *   - Intent (30%): relevance to learning/training niche, remote-friendly
 *   - Quality (20%): field completeness, fresh posting date
 *   - Engagement (10%): company has website, LinkedIn company page
 */

import crypto from "node:crypto";
import { normalizeJobItem } from "../../lib/lane3-scraper-config.mjs";

// ── Helpers ────────────────────────────────────────────────────────────────

const MULTISPACE = /\s+/g;

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
    const url = text.startsWith("http") ? new URL(text) : new URL(`https://${text}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return text.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split(":")[0];
  }
}

function sha1(input) {
  return crypto.createHash("sha1").update(String(input ?? "")).digest("hex");
}

function stableGroupId(...parts) {
  return sha1(parts.filter(Boolean).join("|")).slice(0, 16);
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

// ── Job-Specific Scoring ───────────────────────────────────────────────────

function scoreJobFit(record, context) {
  let score = 0;
  const reasons = [];

  if (record.company_name) { score += 12; reasons.push("has_company"); }
  if (record.job_title)    { score += 10; reasons.push("has_title"); }
  if (record.location)     { score += 8;  reasons.push("has_location"); }

  const searchText = `${record.job_title} ${record.company_name} ${record.raw_snippet} ${record.source} ${context.keyword ?? ""}`.toLowerCase();

  // Keyword match (the keyword used to find this record)
  if (context.keyword && searchText.includes(String(context.keyword).toLowerCase())) {
    score += 15;
    reasons.push("keyword_match");
  }

  // Niche relevance — does the job mention learning/training/education?
  const nicheKeywords = [
    "instructional design", "learning", "training", "LMS", "e-learning", "elearning",
    "education", "course", "curriculum", "learning management", "talent development",
    "organizational development", "L&D", "learning and development",
  ];
  const nicheMatch = nicheKeywords.some((kw) => searchText.includes(kw));
  if (nicheMatch) {
    score += 10;
    reasons.push("niche_relevant");
  }

  // Remote-friendly?
  if (/remote|hybrid|work from home|wfh|telecommute|virtual|distributed/i.test(searchText)) {
    score += 5;
    reasons.push("remote_friendly");
  }

  return { score: clamp(score), reasons };
}

function scoreJobIntent(record) {
  let score = 0;
  const reasons = [];
  const text = `${record.job_title} ${record.raw_snippet ?? ""} ${record.company_name ?? ""}`.toLowerCase();

  // High intent signals (active hiring)
  if (/urgent|immediate|now hiring|join our team|growing|expansion|new position/i.test(text)) {
    score += 12;
    reasons.push("active_hiring");
  }

  // Senior/leadership roles = higher budget signals
  if (/senior|lead|principal|manager|director|head of|leadership|cxo|chief/i.test(text)) {
    score += 8;
    reasons.push("senior_role");
  }

  // EdTech / training-specific signals
  if (/LMS|learning platform|e-learning platform|corporate training|instructional design/i.test(text)) {
    score += 10;
    reasons.push("edtech_signal");
  }

  // Full time / permanent = stronger signal than contract
  if (/full.time|permanent|regular/i.test(text)) {
    score += 5;
    reasons.push("full_time");
  }

  return { score: clamp(score), reasons };
}

function scoreJobQuality(record) {
  let score = 0;
  const reasons = [];

  const fields = [
    record.company_name,
    record.job_title,
    record.posting_url,
    record.location,
    record.raw_snippet,
    record.source,
  ];
  score += fields.filter(Boolean).length * 8;
  if (fields.filter(Boolean).length >= 5) reasons.push("rich_record");

  // Fresh posting date
  if (record.posting_date) {
    const ageHours = (Date.now() - new Date(record.posting_date).getTime()) / 36e5;
    if (ageHours <= 48)      { score += 10; reasons.push("fresh_48h"); }
    else if (ageHours <= 168){ score += 5;  reasons.push("fresh_7d"); }
    else if (ageHours <= 720){ score += 2;  reasons.push("fresh_30d"); }
  }

  return { score: clamp(score), reasons };
}

function scoreJobEngagement(record) {
  let score = 0;
  const reasons = [];

  // Company with a known web presence
  if (record.company_url) {
    score += 10;
    reasons.push("known_company");
  }

  // LinkedIn is a stronger source (job is more likely real)
  if (record.source === "linkedin") {
    score += 5;
    reasons.push("linkedin_source");
  }

  return { score: clamp(score), reasons };
}

function scoreJob(record, context = {}) {
  const fit       = scoreJobFit(record, context);
  const intent    = scoreJobIntent(record);
  const quality   = scoreJobQuality(record);
  const engagement = scoreJobEngagement(record);

  const total = clamp(Math.round(
    (fit.score * 0.40) + (intent.score * 0.30) + (quality.score * 0.20) + (engagement.score * 0.10)
  ));

  const band   = total >= 80 ? "high" : total >= 50 ? "usable" : "low";
  const action = total >= 80 ? "send_first" : total >= 50 ? "keep" : "hold";
  const reasons = [...new Set([...fit.reasons, ...intent.reasons, ...quality.reasons, ...engagement.reasons])];

  return {
    lead_score: total,
    score_band: band,
    recommended_action: action,
    score_breakdown: { fit: fit.score, intent: intent.score, quality: quality.score, engagement: engagement.score },
    score_reasons: reasons,
  };
}

function processBatch(items = [], context = {}) {
  const normalized = items.map((item) => {
    const record = normalizeJobItem(item, context);
    const scoring = scoreJob(record, context);
    const dupKey = [
      normalizeText(record.company_name).toLowerCase(),
      normalizeText(record.job_title)?.toLowerCase(),
      record.source,
    ].filter(Boolean).join("|");

    return {
      ...record,
      ...scoring,
      duplicate_group_id:  stableGroupId(dupKey),
      canonical_entity_id: stableGroupId(dupKey),
      raw_item_hash:       sha1(JSON.stringify(item)),
    };
  });

  const deduped = new Map();
  for (const r of normalized) {
    const current = deduped.get(r.duplicate_group_id);
    if (!current || r.lead_score > current.lead_score) {
      deduped.set(r.duplicate_group_id, r);
    }
  }

  const kept = [...deduped.values()].sort((a, b) => b.lead_score - a.lead_score);
  const counts = {
    total:          normalized.length,
    unique:         kept.length,
    high:           normalized.filter((r) => r.score_band === "high").length,
    usable:         normalized.filter((r) => r.score_band === "usable").length,
    low:            normalized.filter((r) => r.score_band === "low").length,
    duplicate_rate: normalized.length
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
    top_items: kept.slice(0, 10),
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

async function apiPost(url, body, headers = {}) {
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
    order: "requested_at.asc",
    limit: "50",
  });
  return apiGet(
    `${supabaseUrl}/rest/v1/lane3_feed_runs?${qs}`,
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

async function persistBatch(run, batch, { supabaseUrl, supabaseKey }) {
  if (!supabaseUrl || !supabaseKey) return { persisted: false, reason: "missing_supabase_env" };

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    Prefer: "resolution=merge-duplicates,return=minimal",
  };

  const rawRows = batch.items.map((row) => ({
    run_id:          run.id,
    apify_run_id:    run.apify_run_id,
    apify_dataset_id: run.apify_dataset_id,
    payload:         row.raw_item ?? row,
    payload_hash:    row.raw_item_hash,
    collected_at:    row.collected_at,
  }));

  const leadRows = batch.unique_items.map((row) => ({
    run_id:              run.id,
    canonical_entity_id: row.canonical_entity_id,
    duplicate_group_id:  row.duplicate_group_id,
    company_name:        row.company_name,
    job_title:           row.job_title,
    posting_url:         row.posting_url,
    posting_date:        row.posting_date,
    location:            row.location,
    salary:              row.salary,
    source:              row.source,
    keyword:             row.keyword,
    raw_snippet:         row.raw_snippet?.slice(0, 2000),
    collected_at:        row.collected_at,
    lead_score:          row.lead_score,
    score_band:          row.score_band,
    recommended_action:  row.recommended_action,
    score_breakdown:     row.score_breakdown,
    score_reasons:       row.score_reasons,
    workplace_type:      row.workplace_type,
    job_level:           row.job_level,
    company_url:         row.company_url,
  }));

  const rawInsert  = rawRows.length
    ? await apiPost(`${supabaseUrl}/rest/v1/lane3_raw_items?on_conflict=payload_hash`, rawRows, headers)
    : { ok: true, status: 204 };

  const leadInsert = leadRows.length
    ? await apiPost(`${supabaseUrl}/rest/v1/lane3_jobs?on_conflict=run_id,canonical_entity_id`, leadRows, headers)
    : { ok: true, status: 204 };

  const summaryPatch = run.id
    ? await apiPatch(
        `${supabaseUrl}/rest/v1/lane3_feed_runs?id=eq.${encodeURIComponent(run.id)}`,
        {
          status:        "processed",
          processed_at:  new Date().toISOString(),
          total_count:   batch.counts.total,
          unique_count:  batch.counts.unique,
          high_count:    batch.counts.high,
          usable_count:  batch.counts.usable,
          duplicate_rate: batch.counts.duplicate_rate,
          summary: {
            counts:    batch.counts,
            routing:   batch.routing,
            top_items: batch.top_items.slice(0, 3).map((r) => ({
              company_name:      r.company_name,
              job_title:         r.job_title,
              location:           r.location,
              source:             r.source,
              keyword:            r.keyword,
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
    persisted: Boolean(rawInsert.ok && leadInsert.ok && summaryPatch.ok),
    rawInsert:   { ok: rawInsert.ok, status: rawInsert.status },
    leadInsert:  { ok: leadInsert.ok, status: leadInsert.status },
    summaryPatch: { ok: summaryPatch.ok, status: summaryPatch.status },
  };
}

// ── Main handler ───────────────────────────────────────────────────────────

export default async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.THOS_SUPABASE_SERVICE_KEY;
    const apifyToken  = process.env.APIFY_TOKEN;

    // ── Manual/test mode ──────────────────────────────────────────────
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const manualItems = Array.isArray(body.items) ? body.items : [];
      if (!manualItems.length) {
        return res.status(200).json({ ok: true, mode: "idle", note: "No items provided" });
      }
      const context = {
        source:       body.source || "indeed",
        keyword:      body.keyword || "",
        collectedAt:  body.collectedAt || new Date().toISOString(),
      };
      const batch = processBatch(manualItems, context);
      const run = { id: body.run_id || null, apify_run_id: null, apify_dataset_id: null };
      const persisted = supabaseUrl && supabaseKey
        ? await persistBatch(run, batch, { supabaseUrl, supabaseKey })
        : { persisted: false, reason: "no_supabase" };

      return res.status(200).json({
        ok: true, mode: "manual",
        summary: batch.counts,
        routing: batch.routing,
        persisted,
      });
    }

    // ── Queue mode (GET) ──────────────────────────────────────────────
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
      const maxItems = Number(process.env.LANE3_APIFY_MAX_ITEMS ?? "1000");

      let items = [];
      if (datasetId && apifyToken) {
        const dataset = await fetchApifyDataset(datasetId, apifyToken, maxItems);
        if (dataset.ok && Array.isArray(dataset.json)) items = dataset.json;
        else {
          console.error(`[Lane3 Process] dataset fetch failed for run ${run.id}:`, dataset.status);
          continue;
        }
      }
      if (!items.length) {
        console.warn(`[Lane3 Process] no items for run ${run.id}`);
        continue;
      }

      const batch = processBatch(items, {
        source:       run.source || "indeed",
        keyword:      run.keyword || "",
        collectedAt:  run.requested_at || new Date().toISOString(),
      });

      const persisted = await persistBatch(run, batch, { supabaseUrl, supabaseKey });

      outputs.push({
        run_id:  run.id,
        source:  run.source,
        keyword: run.keyword,
        summary: batch.counts,
        persisted,
      });
    }

    return res.status(200).json({
      ok: true,
      mode: "queue",
      processed: outputs.length,
      runs: outputs,
      total_fetched: outputs.reduce((s, o) => s + (o.summary?.total || 0), 0),
    });
  } catch (err) {
    console.error("[Lane3 Process] fatal:", err);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

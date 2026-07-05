/**
 * Lane 4 — Reddit/Forum Processor
 * GET|POST /api/lane4/process
 *
 * Polls lane4_feed_runs for status='queued' rows, fetches Apify datasets,
 * normalizes Reddit posts, scores by buyer-pain/commercial-intent signals,
 * dedupes, and persists to lane4_raw_items + lane4_posts.
 *
 * POST mode accepts manual items for testing.
 *
 * Env vars:
 *   THOS_SUPABASE_URL, THOS_SUPABASE_SERVICE_KEY
 *   APIFY_TOKEN
 *   LANE4_APIFY_MAX_ITEMS      — max dataset fetch size (default 1000)
 *   LANE4_POST_SCORE_CAP       — min score to enqueue (default 50)
 *
 * Scoring dimensions for forum posts:
 *   - Fit (30%): has title, has body, has author, signal keyword match
 *   - Intent (40%): buyer-pain keywords, hiring signals, LMS-switching signals
 *   - Quality (20%): recency, upvote score, comment engagement
 *   - Engagement (10%): subreddit authority, cross-post visibility
 */

import crypto from "node:crypto";
import { normalizeRedditItem, SIGNAL_KEYWORDS } from "../../lib/lane4-scraper-config.mjs";

// ── Helpers ────────────────────────────────────────────────────────────────

const MULTISPACE = /\s+/g;

function normalizeText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(MULTISPACE, " ")
    .trim();
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

// ── Forum-Specific Scoring ─────────────────────────────────────────────────

function scorePostFit(record, context) {
  let score = 0;
  const reasons = [];

  if (record.job_title)  { score += 12; reasons.push("has_title"); }
  if (record.raw_snippet){ score += 8;  reasons.push("has_body"); }
  if (record.company_name){ score += 5; reasons.push("has_author"); }

  const searchText = `${record.job_title} ${record.raw_snippet} ${record.subreddit}`.toLowerCase();

  // Matched signal keywords (already detected in normalize)
  if (record.signal_count > 0) {
    score += Math.min(record.signal_count * 5, 15);
    reasons.push(`signals:${record.signal_count}`);
  }

  return { score: clamp(score), reasons };
}

function scorePostIntent(record) {
  let score = 0;
  const reasons = [];
  const text = `${record.job_title} ${record.raw_snippet ?? ""}`.toLowerCase();

  // Buyer intent — looking to buy or switch
  if (/looking for|recommend.*lms|best.*lms|alternative|switching|replace|considering/i.test(text)) {
    score += 15;
    reasons.push("buyer_intent");
  }

  // Hiring signal
  if (/hiring|we.*hire|job.*opening|position.*available|looking.*hire|recruiting/i.test(text)) {
    score += 12;
    reasons.push("hiring_signal");
  }

  // Pain signal — problems with current solution
  if (/too expensive|frustrated|struggling|difficult|waste|broken|terrible|bad.*experience/i.test(text)) {
    score += 10;
    reasons.push("pain_signal");
  }

  // Budget / purchasing authority
  if (/budget|vendor|quote|pricing|cost|spend|invest|contract/i.test(text)) {
    score += 8;
    reasons.push("budget_signal");
  }

  // Course creation / content signal
  if (/create.*course|course.*creation|authoring|content.*development|curriculum/i.test(text)) {
    score += 8;
    reasons.push("content_signal");
  }

  return { score: clamp(score), reasons };
}

function scorePostQuality(record) {
  let score = 0;
  const reasons = [];

  const fields = [record.job_title, record.raw_snippet, record.company_name, record.posting_url];
  score += fields.filter(Boolean).length * 8;
  if (fields.filter(Boolean).length >= 3) reasons.push("rich_post");

  // Recent post
  if (record.posting_date) {
    const ageHours = (Date.now() - new Date(record.posting_date).getTime()) / 36e5;
    if (ageHours <= 24)      { score += 12; reasons.push("fresh_24h"); }
    else if (ageHours <= 72) { score += 8;  reasons.push("fresh_72h"); }
    else if (ageHours <= 168){ score += 4;  reasons.push("fresh_week"); }
    else if (ageHours <= 720){ score += 2;  reasons.push("fresh_month"); }
  }

  // Upvoted / engaged
  if (Number(record.upvotes || 0) >= 10)   { score += 5; reasons.push("upvoted"); }
  if (Number(record.comment_count || 0) >= 5){ score += 5; reasons.push("discussed"); }

  return { score: clamp(score), reasons };
}

function scorePostEngagement(record) {
  let score = 0;
  const reasons = [];

  // r/instructionaldesign is more niche-relevant than r/elearning
  if ((record.subreddit || "").toLowerCase() === "instructionaldesign") {
    score += 8;
    reasons.push("primary_community");
  }

  // High upvote ratio indicates community validation
  if (record.upvote_ratio !== null && record.upvote_ratio >= 0.85) {
    score += 5;
    reasons.push("strong_sentiment");
  }

  // Active discussion = genuine interest
  if (Number(record.comment_count || 0) >= 10) {
    score += 7;
    reasons.push("active_discussion");
  }

  return { score: clamp(score), reasons };
}

function scorePost(record, context = {}) {
  const fit        = scorePostFit(record, context);
  const intent     = scorePostIntent(record);
  const quality    = scorePostQuality(record);
  const engagement = scorePostEngagement(record);

  const total = clamp(Math.round(
    (fit.score * 0.30) + (intent.score * 0.40) + (quality.score * 0.20) + (engagement.score * 0.10)
  ));

  const band   = total >= 80 ? "high" : total >= 50 ? "usable" : "low";
  const action = total >= 80 ? "send_first" : total >= 50 ? "keep" : "hold";
  const reasons = [...new Set([...fit.reasons, ...intent.reasons, ...quality.reasons, ...engagement.reasons])];

  return {
    signal_score: total,
    score_band: band,
    recommended_action: action,
    score_breakdown: { fit: fit.score, intent: intent.score, quality: quality.score, engagement: engagement.score },
    score_reasons: reasons,
  };
}

function processBatch(items = [], context = {}) {
  const normalized = items.map((item) => {
    const record = normalizeRedditItem(item, context);
    const scoring = scorePost(record, context);
    const dupKey = [
      record.post_id || record.posting_url,
      record.company_name,
      record.subreddit,
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
    if (!current || r.signal_score > current.signal_score) {
      deduped.set(r.duplicate_group_id, r);
    }
  }

  const kept = [...deduped.values()].sort((a, b) => b.signal_score - a.signal_score);
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
      ? Number((normalized.reduce((s, r) => s + Number(r.signal_score || 0), 0) / normalized.length).toFixed(1))
      : 0,
    total_signals:  normalized.reduce((s, r) => s + (r.signal_count || 0), 0),
  };

  return {
    context,
    counts,
    items: normalized,
    unique_items: kept,
    top_items: kept.slice(0, 10),
    routing: {
      instant_alert: kept.filter((r) => r.score_band === "high").length,
      nurture:       kept.filter((r) => r.score_band === "usable").length,
      hold:          kept.filter((r) => r.score_band === "low").length,
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
    order:  "requested_at.asc",
    limit:  "25",
  });
  return apiGet(
    `${supabaseUrl}/rest/v1/lane4_feed_runs?${qs}`,
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

  const postRows = batch.unique_items.map((row) => ({
    run_id:              run.id,
    canonical_entity_id: row.canonical_entity_id,
    duplicate_group_id:  row.duplicate_group_id,
    post_id:             row.post_id,
    post_title:          row.job_title,
    post_author:         row.company_name,
    post_url:            row.posting_url,
    post_date:           row.posting_date,
    subreddit:           row.subreddit,
    raw_snippet:         row.raw_snippet?.slice(0, 2000),
    upvotes:             row.upvotes,
    comment_count:       row.comment_count,
    source:              row.source,
    collected_at:        row.collected_at,
    signal_score:        row.signal_score,
    score_band:          row.score_band,
    recommended_action:  row.recommended_action,
    score_breakdown:     row.score_breakdown,
    score_reasons:       row.score_reasons,
    matched_signals:     row.matched_signals,
    signal_count:        row.signal_count,
  }));

  const rawInsert  = rawRows.length
    ? await apiPost(`${supabaseUrl}/rest/v1/lane4_raw_items?on_conflict=payload_hash`, rawRows, headers)
    : { ok: true, status: 204 };

  const postInsert = postRows.length
    ? await apiPost(`${supabaseUrl}/rest/v1/lane4_posts?on_conflict=run_id,canonical_entity_id`, postRows, headers)
    : { ok: true, status: 204 };

  const summaryPatch = run.id
    ? await apiPatch(
        `${supabaseUrl}/rest/v1/lane4_feed_runs?id=eq.${encodeURIComponent(run.id)}`,
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
              post_title:    r.job_title,
              subreddit:     r.subreddit,
              post_author:   r.company_name,
              signal_score:  r.signal_score,
              score_band:    r.score_band,
              matched_signals: r.matched_signals,
            })),
          },
        },
        headers
      )
    : { ok: true, status: 204 };

  return {
    persisted: Boolean(rawInsert.ok && postInsert.ok && summaryPatch.ok),
    rawInsert:   { ok: rawInsert.ok, status: rawInsert.status },
    postInsert:  { ok: postInsert.ok, status: postInsert.status },
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
        source:       "reddit",
        subreddit:    body.subreddit || "",
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
      const maxItems = Number(process.env.LANE4_APIFY_MAX_ITEMS ?? "1000");

      let items = [];
      if (datasetId && apifyToken) {
        const dataset = await fetchApifyDataset(datasetId, apifyToken, maxItems);
        if (dataset.ok && Array.isArray(dataset.json)) items = dataset.json;
        else {
          console.error(`[Lane4 Process] dataset fetch failed for run ${run.id}:`, dataset.status);
          continue;
        }
      }
      if (!items.length) {
        console.warn(`[Lane4 Process] no items for run ${run.id}`);
        continue;
      }

      const batch = processBatch(items, {
        source:       "reddit",
        subreddit:    run.subreddit || "",
        collectedAt:  run.requested_at || new Date().toISOString(),
      });

      const persisted = await persistBatch(run, batch, { supabaseUrl, supabaseKey });

      outputs.push({
        run_id:    run.id,
        subreddit: run.subreddit,
        summary:   batch.counts,
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
    console.error("[Lane4 Process] fatal:", err);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

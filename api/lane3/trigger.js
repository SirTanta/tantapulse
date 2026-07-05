/**
 * Lane 3 — Job Boards Trigger Handler
 * POST /api/lane3/trigger
 *
 * Trigger an Apify run for each {source × keyword} combination.
 * Iterates over all keywords in SEARCH_KEYWORDS for both Indeed and LinkedIn.
 *
 * Runs the spend guard once (global cap), then loops over keyword configs.
 * Each keyword run gets its own lane3_feed_runs record so the processor
 * can fetch datasets individually and the scoring step can attribute
 * records to the keyword that matched them.
 *
 * Env vars:
 *   APIFY_TOKEN                  — Apify API token (required)
 *   LANE3_APIFY_BUDGET           — hard spend cap in USD (default "25.00")
 *   LANE3_APIFY_OVERHEAD_PCT     — safety buffer fraction (default 0.05)
 *   LANE3_APIFY_EST_RUN_COST     — fallback est. run cost if headers unavailable (default "1.50")
 *
 *   LANE3_INDEED_ACTOR_ID        — override Indeed actor ID
 *   LANE3_INDEED_MAX_ITEMS       — max items per Indeed run (default 150)
 *   LANE3_INDEED_EST_COST        — per-run cost est for Indeed (default 0.59)
 *
 *   LANE3_LINKEDIN_ACTOR_ID      — override LinkedIn actor ID
 *   LANE3_LINKEDIN_MAX_ITEMS     — max items per LinkedIn run (default 100)
 *   LANE3_LINKEDIN_EST_COST      — per-run cost est for LinkedIn (default 1.50)
 */

import { checkAndReserveApifyRun, buildSpendCheckRecord } from "../../lib/lane2-spend-guard.mjs";
import {
  SOURCE_ACTORS,
  SEARCH_KEYWORDS,
  generateAllSearchConfigs,
} from "../../lib/lane3-scraper-config.mjs";

const ALLOWED_ORIGINS = new Set([
  "https://tantapulse.com",
  "https://www.tantapulse.com",
  "http://localhost:3000",
  "http://localhost:3001",
]);

function originAllowed(req) {
  const origin = req.headers.origin || req.headers.referer || "";
  if (!origin) return true;
  try {
    return ALLOWED_ORIGINS.has(new URL(origin).origin);
  } catch {
    return false;
  }
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

async function apiGet(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* noop */ }
  return { ok: res.ok, status: res.status, text, json };
}

/**
 * Launch one Apify actor run.
 */
async function launchApifyRun({ apifyToken, actorId, input }) {
  const url = `https://api.apify.com/v2/acts/${actorId}/runs?token=${encodeURIComponent(apifyToken)}&waitForFinish=0`;
  const res = await apiPost(url, input);
  if (!res.ok) {
    throw new Error(`Apify run launch failed ${res.status}: ${res.text.slice(0, 300)}`);
  }
  const runId = res.json?.data?.id ?? null;
  const datasetId = res.json?.data?.defaultDatasetId ?? null;
  return { runId, datasetId };
}

/**
 * Create a lane3_feed_runs record in Supabase.
 */
async function createRunRecord({ supabaseUrl, supabaseKey, source, keyword, apifyRunId, apifyDatasetId, spendCheck }) {
  if (!supabaseUrl || !supabaseKey) return null;
  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    Prefer: "return=minimal",
  };
  const body = [{
    source,
    keyword,
    apify_run_id: apifyRunId,
    apify_dataset_id: apifyDatasetId,
    status: spendCheck.allowed ? "queued" : "capped",
    spend_check: buildSpendCheckRecord(spendCheck),
    requested_at: new Date().toISOString(),
  }];
  const res = await apiPost(`${supabaseUrl}/rest/v1/lane3_feed_runs`, body, headers);
  return res.json;
}

export default async function handler(req, res) {
  if (!originAllowed(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.THOS_SUPABASE_SERVICE_KEY;
  const apifyToken = process.env.APIFY_TOKEN;
  const budgetCap = Number(process.env.LANE3_APIFY_BUDGET ?? "25.00");
  const overheadPct = Number(process.env.LANE3_APIFY_OVERHEAD_PCT ?? "0.05");

  if (!apifyToken) {
    return res.status(200).json({
      ok: false,
      reason: "APIFY_TOKEN not configured",
      configs: [],
    });
  }

  // ── 1. Run global spend guard ──────────────────────────────────────
  const estRunCost = Number(
    process.env.LANE3_APIFY_EST_RUN_COST ?? (
      (SOURCE_ACTORS.indeed.estCostPerRun + SOURCE_ACTORS.linkedin.estCostPerRun) * SEARCH_KEYWORDS.length
    ).toFixed(2)
  );

  const spendCheck = await checkAndReserveApifyRun({
    apifyToken,
    budgetCapUsd: budgetCap,
    estimatedRunCostUsd: estRunCost,
    overheadPct,
  });

  if (!spendCheck.allowed) {
    if (supabaseUrl && supabaseKey) {
      // Log the blocked run
      await createRunRecord({
        supabaseUrl, supabaseKey,
        source: "all",
        keyword: "global",
        apifyRunId: null,
        apifyDatasetId: null,
        spendCheck,
      });
    }
    return res.status(200).json({
      ok: true,
      allowed: false,
      state: spendCheck.state,
      reason: spendCheck.reason,
      budget_remaining_usd: spendCheck.budgetRemainingUsd,
      message: "Spend guard blocked Lane 3 sweep. Check LANE3_APIFY_BUDGET or wait for credits.",
    });
  }

  // ── 2. Generate all keyword configs ────────────────────────────────
  const configs = generateAllSearchConfigs();
  const results = [];

  for (const cfg of configs) {
    let apifyRunId = null;
    let apifyDatasetId = null;
    let launchError = null;

    try {
      const run = await launchApifyRun({ apifyToken, actorId: cfg.actorId, input: cfg.input });
      apifyRunId = run.runId;
      apifyDatasetId = run.datasetId;
    } catch (err) {
      launchError = err.message;
    }

    // Persist run record regardless of success
    if (supabaseUrl && supabaseKey) {
      await createRunRecord({
        supabaseUrl, supabaseKey,
        source: cfg.source,
        keyword: cfg.keyword,
        apifyRunId,
        apifyDatasetId,
        spendCheck: launchError
          ? { ...spendCheck, reason: `launch_error:${launchError}` }
          : spendCheck,
      });
    }

    results.push({
      source: cfg.source,
      keyword: cfg.keyword,
      ok: !launchError,
      apify: launchError ? null : { runId: apifyRunId, datasetId: apifyDatasetId },
      error: launchError,
    });
  }

  // ── 3. Summary ─────────────────────────────────────────────────────
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  return res.status(200).json({
    ok: true,
    allowed: true,
    state: spendCheck.state,
    summary: {
      total: results.length,
      succeeded,
      failed,
      sources: {
        indeed: results.filter((r) => r.source === "indeed").filter((r) => r.ok).length,
        linkedin: results.filter((r) => r.source === "linkedin").filter((r) => r.ok).length,
      },
    },
    results,
    spend: {
      reservation_id: spendCheck.reservationId,
      budget_remaining_usd: spendCheck.budgetRemainingUsd,
    },
  });
}

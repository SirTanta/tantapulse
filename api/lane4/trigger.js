/**
 * Lane 4 — Reddit/Forum Trigger Handler
 * POST /api/lane4/trigger
 *
 * Launches Apify Reddit scraping runs for r/instructionaldesign and r/elearning.
 * Runs the spend guard, then fires one run per subreddit.
 *
 * Env vars:
 *   APIFY_TOKEN                  — Apify API token (required)
 *   LANE4_APIFY_BUDGET           — hard spend cap in USD (default "5.00")
 *   LANE4_APIFY_OVERHEAD_PCT     — safety buffer fraction (default 0.05)
 *   LANE4_REDDIT_ACTOR_ID        — override Reddit actor ID
 *   LANE4_REDDIT_MAX_ITEMS       — max items per subreddit (default 100)
 *   LANE4_REDDIT_EST_COST        — per-run cost estimate (default 0.10)
 */

import { checkAndReserveApifyRun, buildSpendCheckRecord } from "../../lib/lane2-spend-guard.mjs";
import {
  SUBREDDITS,
  REDDIT_ACTORS,
  generateAllSubredditConfigs,
} from "../../lib/lane4-scraper-config.mjs";

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

async function createRunRecord({ supabaseUrl, supabaseKey, subreddit, apifyRunId, apifyDatasetId, spendCheck }) {
  if (!supabaseUrl || !supabaseKey) return null;
  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    Prefer: "return=minimal",
  };
  const body = [{
    subreddit,
    source: "reddit",
    apify_run_id: apifyRunId,
    apify_dataset_id: apifyDatasetId,
    status: spendCheck.allowed ? "queued" : "capped",
    spend_check: buildSpendCheckRecord(spendCheck),
    requested_at: new Date().toISOString(),
  }];
  return apiPost(`${supabaseUrl}/rest/v1/lane4_feed_runs`, body, headers);
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
  const budgetCap = Number(process.env.LANE4_APIFY_BUDGET ?? "5.00");
  const overheadPct = Number(process.env.LANE4_APIFY_OVERHEAD_PCT ?? "0.05");

  if (!apifyToken) {
    return res.status(200).json({
      ok: false,
      reason: "APIFY_TOKEN not configured",
      configs: [],
    });
  }

  // ── 1. Spend guard ──────────────────────────────────────────────────
  const estRunCost = Number(
    process.env.LANE4_APIFY_EST_RUN_COST ?? (
      REDDIT_ACTORS.primary.estCostPerRun * SUBREDDITS.length
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
      await createRunRecord({
        supabaseUrl, supabaseKey,
        subreddit: "all",
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
      message: "Spend guard blocked Lane 4 sweep. Check LANE4_APIFY_BUDGET.",
    });
  }

  // ── 2. Launch runs ──────────────────────────────────────────────────
  const configs = generateAllSubredditConfigs();
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

    if (supabaseUrl && supabaseKey) {
      await createRunRecord({
        supabaseUrl, supabaseKey,
        subreddit: cfg.subreddit,
        apifyRunId,
        apifyDatasetId,
        spendCheck: launchError
          ? { ...spendCheck, reason: `launch_error:${launchError}` }
          : spendCheck,
      });
    }

    results.push({
      subreddit: cfg.subreddit,
      ok: !launchError,
      apify: launchError ? null : { runId: apifyRunId, datasetId: apifyDatasetId },
      error: launchError,
    });
  }

  return res.status(200).json({
    ok: true,
    allowed: true,
    state: spendCheck.state,
    summary: {
      total: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    },
    results,
    spend: {
      reservation_id: spendCheck.reservationId,
      budget_remaining_usd: spendCheck.budgetRemainingUsd,
    },
  });
}

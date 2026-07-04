/**
 * Lane 2 — trigger handler
 * POST /api/lane2/trigger
 *
 * Runs the spend guard, then launches the Apify HVAC/Austin actor.
 * If the guard blocks the run, it records the cap event and returns the
 * block reason without calling Apify.
 *
 * Env vars required:
 *   APIFY_TOKEN              — Apify API token
 *   LANE2_APIFY_BUDGET       — hard cap in USD (e.g. "5.00")
 *   LANE2_APIFY_EST_RUN_COST — estimated cost per run in USD (e.g. "0.10")
 *   LANE2_APIFY_MAX_ITEMS    — max items per run (default 50)
 *
 * Optional env:
 *   LANE2_APIFY_ACTOR_ID     — override actor ID (default: TantaPulse default)
 *   LANE2_OVERHEAD_PCT       — safety overhead fraction (default 0.05 = 5%)
 */

import {
  checkAndReserveApifyRun,
  SPEND_STATES,
  buildSpendCheckRecord,
} from "../../lib/lane2-spend-guard.mjs";

import {
  SCRAPER_CONFIG,
  enrichHvacItem,
} from "../../lib/lane2-scraper-config.mjs";

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

/**
 * Launch the Apify actor run and return { runId, datasetId }.
 */
async function launchApifyRun({ apifyToken, actorId, input }) {
  const url =
    `https://api.apify.com/v2/acts/${actorId}/runs?token=${encodeURIComponent(apifyToken)}&waitForFinish=0`;
  const res = await apiPost(url, input);
  if (!res.ok) {
    throw new Error(`Apify run launch failed ${res.status}: ${res.text}`);
  }
  const runId = res.json?.data?.id ?? null;
  const datasetId = res.json?.data?.defaultDatasetId ?? null;
  return { runId, datasetId };
}

/**
 * Create a lane2_feed_runs record in Supabase.
 */
async function createRunRecord({
  supabaseUrl,
  supabaseKey,
  apifyRunId,
  apifyDatasetId,
  spendCheck,
}) {
  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    Prefer: "return=minimal",
  };
  const body = [{
    apify_run_id: apifyRunId,
    apify_dataset_id: apifyDatasetId,
    status: spendCheck.allowed ? "queued" : "capped",
    spend_check: buildSpendCheckRecord(spendCheck),
    requested_at: new Date().toISOString(),
  }];
  return apiPost(`${supabaseUrl}/rest/v1/lane2_feed_runs`, body, headers);
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
  const budgetCap = Number(process.env.LANE2_APIFY_BUDGET ?? "5.00");
  const estRunCost = Number(process.env.LANE2_APIFY_EST_RUN_COST ?? "0.10");
  const overheadPct = Number(process.env.LANE2_OVERHEAD_PCT ?? "0.05");

  // ── 1. Spend guard ────────────────────────────────────────────────────
  if (!apifyToken) {
    return res.status(200).json({
      ok: false,
      reason: "APIFY_TOKEN not configured",
      allowed: false,
    });
  }

  const spendCheck = await checkAndReserveApifyRun({
    apifyToken,
    budgetCapUsd: budgetCap,
    estimatedRunCostUsd: estRunCost,
    overheadPct,
  });

  // Always persist the check result, even if blocked
  if (supabaseUrl && supabaseKey) {
    await createRunRecord({
      supabaseUrl,
      supabaseKey,
      apifyRunId: null,
      apifyDatasetId: null,
      spendCheck,
    });
  }

  if (!spendCheck.allowed) {
    return res.status(200).json({
      ok: true,
      allowed: false,
      state: spendCheck.state,
      reason: spendCheck.reason,
      budget_current_usd: spendCheck.budgetCurrentUsd,
      budget_remaining_usd: spendCheck.budgetRemainingUsd,
      estimated_run_cost_usd: spendCheck.estimatedRunCostUsd,
      message: "Spend guard blocked this run. Check LANE2_APIFY_BUDGET or wait for credits to replenish.",
    });
  }

  // ── 2. Launch Apify run ───────────────────────────────────────────────
  const actorId = process.env.LANE2_APIFY_ACTOR_ID || SCRAPER_CONFIG.actorId;
  const searchString = SCRAPER_CONFIG.buildSearchString({
    niche: "HVAC",
    city: "Austin",
    state: "TX",
  });
  const maxItems = Number(process.env.LANE2_APIFY_MAX_ITEMS ?? SCRAPER_CONFIG.maxItems);
  const actorInput = SCRAPER_CONFIG.buildActorInput({ searchString, maxItems });

  let apifyRunId = null;
  let apifyDatasetId = null;
  let apifyLaunched = false;

  try {
    const run = await launchApifyRun({ apifyToken, actorId, input: actorInput });
    apifyRunId = run.runId;
    apifyDatasetId = run.datasetId;
    apifyLaunched = true;
  } catch (err) {
    // Run was guard-approved but Apify launch failed — record and report
    console.error("[Lane2 Trigger] Apify launch failed:", err.message);
    if (supabaseUrl && supabaseKey) {
      await createRunRecord({
        supabaseUrl,
        supabaseKey,
        apifyRunId: null,
        apifyDatasetId: null,
        spendCheck: {
          ...spendCheck,
          reason: `launch_error:${err.message}`,
        },
      });
    }
    return res.status(200).json({
      ok: false,
      allowed: true,
      state: spendCheck.state,
      reason: `launch_error:${err.message}`,
      message: "Spend guard passed but Apify actor launch failed. Check Apify token and actor status.",
    });
  }

  // ── 3. Persist queued run record ──────────────────────────────────────
  if (supabaseUrl && supabaseKey) {
    await createRunRecord({
      supabaseUrl,
      supabaseKey,
      apifyRunId,
      apifyDatasetId,
      spendCheck,
    });
  }

  return res.status(200).json({
    ok: true,
    allowed: true,
    state: spendCheck.state,
    apify: {
      queued: apifyLaunched,
      runId: apifyRunId,
      datasetId: apifyDatasetId,
      actorId,
      searchString,
      maxItems,
    },
    spend: {
      reservation_id: spendCheck.reservationId,
      budget_current_usd: spendCheck.budgetCurrentUsd,
      budget_remaining_usd: spendCheck.budgetRemainingUsd,
      estimated_run_cost_usd: spendCheck.estimatedRunCostUsd,
    },
  });
}

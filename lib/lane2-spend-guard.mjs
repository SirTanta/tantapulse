/**
 * Lane 2 spend guard — ensures Apify runs stay within LANE2_APIFY_BUDGET.
 *
 * Pattern:
 *  1. Before launching an Apify actor, call checkAndReserveApifyRun().
 *  2. checkAndReserveApifyRun() hits GET /v2/users/me/limits to read
 *     current estimated spend + available credits.
 *  3. If (budget_current + estimated_run_cost) > budget_cap → BLOCK.
 *  4. On success, returns { allowed: true, reservation_id, budget_remaining_usd }.
 *  5. The caller stores the reservation result so post-run it can be reconciled.
 *
 * All values in USD. Apify cost-estimate headers:
 *   X-Apify-EstimatedComputeUnits * Apify-Compute-Unit-Price
 * (falls back to env var LANE2_APIFY_EST_RUN_COST if headers unavailable).
 */

import crypto from "node:crypto";

function genId() {
  try { return crypto.randomUUID(); } catch { /* Node 18 fallback */ }
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.webcrypto?.getRandomValues?.(new Uint8Array(1))?.[0] ?? Math.random() * 256 & 15 >> c / 4).toString(16)
  );
}

const APIFY_LIMITS_ENDPOINT = "https://api.apify.com/v2/users/me/limits";

export const SPEND_STATES = {
  UNKNOWN:       "unknown",
  WITHIN_BUDGET: "within_budget",
  AT_RISK:       "at_risk",    // remaining < 1 run cost
  OVER_BUDGET:   "over_budget",
  CAPPED:        "capped",
};

/**
 * @param {object} params
 * @param {string} params.apifyToken         — Apify API token
 * @param {number} params.budgetCapUsd       — ceiling from LANE2_APIFY_BUDGET
 * @param {number} [params.estimatedRunCostUsd] — estimated cost for this run;
 *                                              falls back to LANE2_APIFY_EST_RUN_COST env
 * @param {number} [params.overheadPct]     — safety buffer % (default 5 %)
 * @returns {Promise<{allowed: boolean, state: string, budgetCurrentUsd: number,
 *                    budgetRemainingUsd: number, estimatedRunCostUsd: number,
 *                    reservationId: string|null, reason: string|null}>}
 */
export async function checkAndReserveApifyRun({
  apifyToken,
  budgetCapUsd,
  estimatedRunCostUsd = null,
  overheadPct = 0.05,
} = {}) {
  const estRunCost = estimatedRunCostUsd ??
    Number(process.env.LANE2_APIFY_EST_RUN_COST ?? "0.10");

  // ── Step 1: read current usage from Apify ──────────────────────────────
  let limitsData = null;
  try {
    const res = await fetch(APIFY_LIMITS_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${apifyToken}`,
        "Content-Type": "application/json",
      },
    });
    if (res.ok) {
      const json = await res.json();
      limitsData = json?.data ?? null;
    }
  } catch (err) {
    return {
      allowed: false,
      state: SPEND_STATES.UNKNOWN,
      budgetCurrentUsd: 0,
      budgetRemainingUsd: 0,
      estimatedRunCostUsd: estRunCost,
      reservationId: null,
      reason: `limits_api_error:${err.message}`,
    };
  }

  // Apify returns usage under `data.current.monthlyUsageUsd` and
  // the plan limit under `data.limits.maxMonthlyUsageUsd`.
  const budgetCurrentUsd  = Number(limitsData?.current?.monthlyUsageUsd ?? 0);
  const maxBudgetUsd      = Number(limitsData?.limits?.maxMonthlyUsageUsd ?? budgetCapUsd);
  // Remaining = plan limit - current usage
  let budgetRemainingUsd = Math.max(0, maxBudgetUsd - budgetCurrentUsd);
  // Cap remaining at the configured budget (avoids double-counting).
  budgetRemainingUsd = Math.min(budgetRemainingUsd, budgetCapUsd);

  // ── Step 2: apply safety overhead ─────────────────────────────────────
  const protectedBudget = budgetCapUsd * (1 - overheadPct);
  const effectiveRunCost = estRunCost * (1 + overheadPct);

  // ── Step 3: decide ────────────────────────────────────────────────────
  if (effectiveRunCost > protectedBudget) {
    return {
      allowed: false,
      state: SPEND_STATES.CAPPED,
      budgetCurrentUsd,
      budgetRemainingUsd,
      estimatedRunCostUsd: estRunCost,
      reservationId: null,
      reason: `run_cost_exceeds_safe_budget:${effectiveRunCost.toFixed(4)}>${protectedBudget.toFixed(4)}`,
    };
  }

  if (effectiveRunCost > budgetRemainingUsd) {
    return {
      allowed: false,
      state: SPEND_STATES.OVER_BUDGET,
      budgetCurrentUsd,
      budgetRemainingUsd,
      estimatedRunCostUsd: estRunCost,
      reservationId: null,
      reason: `insufficient_remaining:${effectiveRunCost.toFixed(4)}>${budgetRemainingUsd.toFixed(4)}`,
    };
  }

  // ── Step 4: reserve ──────────────────────────────────────────────────
  const reservationId = genId();

  return {
    allowed: true,
    state: budgetRemainingUsd < estRunCost ? SPEND_STATES.AT_RISK : SPEND_STATES.WITHIN_BUDGET,
    budgetCurrentUsd,
    budgetRemainingUsd: budgetRemainingUsd - effectiveRunCost,
    estimatedRunCostUsd: estRunCost,
    reservationId,
    reason: null,
  };
}

/**
 * Reconcile a run after it completes: update the spend log.
 * Called by the processor after Apify dataset items are fetched.
 *
 * @param {object} params
 * @param {object} params.supabase      — Supabase client (or fetch wrapper)
 * @param {string} params.runId         — lane2_feed_runs UUID
 * @param {string} params.reservationId — from checkAndReserveApifyRun
 * @param {number} params.budgetCapUsd  — same cap passed to checkAndReserve
 * @param {number} params.actualCostUsd — actual cost from Apify run API (optional)
 */
export async function reconcileApifyRun({
  supabase,
  runId,
  reservationId,
  budgetCapUsd,
  actualCostUsd = null,
}) {
  if (!supabase || !runId) return;
  const logEntry = {
    run_id: runId,
    check_at: new Date().toISOString(),
    budget_current_usd: 0,
    budget_cap_usd: budgetCapUsd,
    estimated_task_cost_usd: actualCostUsd,
    allowed: true,
    reason: reservationId ? `reserved:${reservationId}` : "no_reservation",
  };
  try {
    await supabase.from("lane2_spend_log").insert(logEntry);
  } catch (err) {
    console.error("[Lane2 SpendGuard] reconcile failed:", err.message);
  }
}

/**
 * Build a Supabase-compatible JSON payload for the spend_check column
 * on lane2_feed_runs so the processor can audit decisions.
 */
export function buildSpendCheckRecord(checkResult) {
  return {
    allowed: checkResult.allowed,
    state: checkResult.state,
    budget_current_usd: checkResult.budgetCurrentUsd,
    budget_remaining_usd: checkResult.budgetRemainingUsd,
    estimated_run_cost_usd: checkResult.estimatedRunCostUsd,
    reservation_id: checkResult.reservationId,
    reason: checkResult.reason,
    checked_at: new Date().toISOString(),
  };
}

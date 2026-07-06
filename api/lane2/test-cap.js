/**
 * Lane 2 — spend-guard cap-test endpoint
 * GET /api/lane2/test-cap?budget=<USD>&estCost=<USD>
 *
 * Simulates a spend guard run without touching Apify or Supabase.
 * Returns the full checkAndReserveApifyRun result so callers can
 * verify the guard logic and budget arithmetic.
 *
 * Optional query params:
 *   budget     — override LANE2_APIFY_BUDGET for this test (USD)
 *   estCost    — override estimated run cost for this test (USD)
 *   overheadPct — safety overhead fraction (default 0.05)
 *
 * Example:
 *   GET /api/lane2/test-cap?budget=0.05&estCost=0.10
 *   → { allowed: false, state: "capped", reason: "run_cost_exceeds..." }
 */

import crypto from "node:crypto";
import { checkAndReserveApifyRun, SPEND_STATES } from "../../lib/lane2-spend-guard.mjs";

function genId() {
  // Node 18 compatible UUID generation (global crypto.randomUUID is Node 19+)
  try { return crypto.randomUUID(); } catch { /* fallback below */ }
  // Fallback for Node 18
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.webcrypto?.getRandomValues?.(new Uint8Array(1))?.[0] ?? Math.random() * 256 & 15 >> c / 4).toString(16)
  );
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apifyToken  = process.env.APIFY_TOKEN;
  const budgetCap   = Number(req.query.budget  ?? process.env.LANE2_APIFY_BUDGET ?? "5.00");
  const estRunCost  = Number(req.query.estCost ?? process.env.LANE2_APIFY_EST_RUN_COST ?? "0.10");
  const overheadPct = Number(req.query.overheadPct ?? "0.05");

  // If a real token is present, hit the live Apify limits API.
  // Otherwise return a mock that simulates the guard logic.
  if (!apifyToken) {
    // Simulate budget arithmetic without calling Apify
    const protectedBudget = budgetCap * (1 - overheadPct);
    const effectiveRunCost = estRunCost * (1 + overheadPct);

    let allowed, state, reason;
    if (effectiveRunCost > protectedBudget) {
      allowed = false; state = SPEND_STATES.CAPPED;
      reason = `run_cost_exceeds_safe_budget:${effectiveRunCost.toFixed(4)}>${protectedBudget.toFixed(4)}`;
    } else {
      // Simulate we have exactly (protectedBudget) remaining
      allowed = effectiveRunCost <= protectedBudget;
      state   = allowed ? SPEND_STATES.WITHIN_BUDGET : SPEND_STATES.OVER_BUDGET;
      reason  = allowed
        ? null
        : `insufficient_remaining:${effectiveRunCost.toFixed(4)}>${protectedBudget.toFixed(4)}`;
    }

    return res.status(allowed ? 200 : 200).json(
      allowed
        ? {
            ok: true,
            mode: "simulated",
            params: { budgetCap, estRunCost, overheadPct },
            result: {
              allowed,
              state,
              budget_current_usd:    budgetCap - protectedBudget,
              budget_remaining_usd: protectedBudget - effectiveRunCost,
              estimated_run_cost_usd: estRunCost,
              reservation_id: "sim-" + genId(),
              reason: null,
              note: "No APIFY_TOKEN set — using simulated budget arithmetic. Set APIFY_TOKEN for live Apify limits check.",
            },
          }
        : {
            ok: false,
            mode: "simulated",
            params: { budgetCap, estRunCost, overheadPct },
            error: reason,
            result: {
              allowed,
              state,
              budget_current_usd:    budgetCap - protectedBudget,
              budget_remaining_usd: protectedBudget - effectiveRunCost,
              estimated_run_cost_usd: estRunCost,
              reservation_id: null,
              reason,
              note: "No APIFY_TOKEN set — using simulated budget arithmetic. Set APIFY_TOKEN for live Apify limits check.",
            },
          }
    );
  }

  // Live Apify limits check
  let result;
  try {
    result = await checkAndReserveApifyRun({
      apifyToken,
      budgetCapUsd:       budgetCap,
      estimatedRunCostUsd: estRunCost,
      overheadPct,
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      mode: "live",
      error: `checkAndReserveApifyRun threw: ${err.message}`,
    });
  }

  if (!result.allowed) {
    return res.status(200).json({
      ok: false,
      mode: "live",
      params: { budgetCap, estRunCost, overheadPct },
      error: result.reason ?? `spend_guard_denied:${result.state}`,
      result: {
        allowed:               false,
        state:                 result.state,
        budget_current_usd:    result.budgetCurrentUsd,
        budget_remaining_usd:  result.budgetRemainingUsd,
        estimated_run_cost_usd: result.estimatedRunCostUsd,
        reservation_id:        null,
        reason:                result.reason,
      },
    });
  }

  return res.status(200).json({
    ok: true,
    mode: "live",
    params: { budgetCap, estRunCost, overheadPct },
    result: {
      allowed:               result.allowed,
      state:                 result.state,
      budget_current_usd:    result.budgetCurrentUsd,
      budget_remaining_usd:  result.budgetRemainingUsd,
      estimated_run_cost_usd: result.estimatedRunCostUsd,
      reservation_id:        result.reservationId,
      reason:                result.reason,
    },
  });
}

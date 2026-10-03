import { checkAndReserveApifyRun, buildSpendCheckRecord } from "../../lib/lane2-spend-guard.mjs";
import { recordHeartbeat } from "../../lib/pulse-heartbeat.mjs";

function normalizeText(value) { return String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim(); }
function safeJson(text) { try { return text ? JSON.parse(text) : null; } catch { return null; } }
async function apiPost(url, body, headers = {}) { const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }); const text = await res.text(); return { ok: res.ok, status: res.status, text, json: safeJson(text) }; }
async function apiPatch(url, body, headers = {}) { const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }); const text = await res.text(); return { ok: res.ok, status: res.status, text, json: safeJson(text) }; }
function supabaseHeaders(supabaseKey, extra = {}) { return { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, ...extra }; }
async function launchApifyRun({ apifyToken, actorId, input }) { const url = `https://api.apify.com/v2/acts/${actorId}/runs?token=${encodeURIComponent(apifyToken)}&waitForFinish=0`; const res = await apiPost(url, input); if (!res.ok) throw new Error(`Apify run launch failed ${res.status}: ${res.text}`); return { runId: res.json?.data?.id ?? null, datasetId: res.json?.data?.defaultDatasetId ?? null }; }
async function createRunRecord({ supabaseUrl, supabaseKey, record }) { return apiPost(`${supabaseUrl}/rest/v1/sales_discovery_runs`, [record], supabaseHeaders(supabaseKey, { Prefer: "resolution=merge-duplicates,return=minimal" })); }
// Bridges a launched Apify run into lead_feed_runs so the existing daily
// /api/lead-feed/process cron (vercel.json, already scheduled 10:10 UTC) picks up
// the dataset and writes real rows into lead_feed_leads -- the actual outbound pool
// used by MCA-803 sending. Without this bridge, a sales-discovery run only ever lands
// in sales_discovery_candidates (BD triage), never refilling the send pool.
// 2026-10-03 (MCA lead-discovery expansion, Jon-approved "yes expand"): added after finding
// the pool-refill path was fully disconnected from this trigger.
async function createLeadFeedRunRecord({ supabaseUrl, supabaseKey, niche, city, apifyRunId, apifyDatasetId }) {
  if (!supabaseUrl || !supabaseKey) return { ok: false, reason: "missing_supabase_env" };
  const record = { niche, city, source: "apify", apify_run_id: apifyRunId, apify_dataset_id: apifyDatasetId, status: "queued", requested_at: new Date().toISOString() };
  return apiPost(`${supabaseUrl}/rest/v1/lead_feed_runs`, [record], supabaseHeaders(supabaseKey, { Prefer: "return=minimal" }));
}

// Default vetted lead-discovery sweep used when no explicit actor_id/actor_input is
// posted (covers the GET invocation Vercel Cron makes, and a bare POST with no body).
// Same vertical + confidence-bar criteria that already qualified 67-of-334 Austin records
// (MCA-803); geography expanded 2026-10-03 (Jon: "yes expand") to comparable metro markets.
const DEFAULT_SEARCH_TERMS = (process.env.SALES_DISCOVERY_SEARCH_TERMS || "local SEO agency,SEO company,digital marketing agency,SEO consultant")
  .split(",").map((s) => s.trim()).filter(Boolean);
const DEFAULT_MARKETS = (process.env.SALES_DISCOVERY_MARKETS || "Denver, CO|Nashville, TN|Raleigh, NC|Phoenix, AZ")
  .split("|").map((s) => s.trim()).filter(Boolean);
const DEFAULT_ACTOR_ID = process.env.SALES_DISCOVERY_APIFY_ACTOR_ID || process.env.LANE2_APIFY_ACTOR_ID || "nwua9Gu5YrADL7ZDj"; // compass/crawler-google-places
const DEFAULT_MAX_PLACES = Number(process.env.SALES_DISCOVERY_APIFY_MAX_ITEMS || "100");

async function runSingleDiscovery({ supabaseUrl, supabaseKey, apifyToken, budgetCap, estRunCost, overheadPct, actorId, actorInput, sourceLane, sourceName, sourceId, leadFeedNiche, leadFeedCity }) {
  const spendCheck = await checkAndReserveApifyRun({ apifyToken, budgetCapUsd: budgetCap, estimatedRunCostUsd: estRunCost, overheadPct });
  const baseRecord = { source_class: "apify", source_lane: sourceLane, source_name: sourceName, source_id: sourceId || actorId, status: spendCheck.allowed ? "queued" : "capped", spend_check: buildSpendCheckRecord(spendCheck), requested_at: new Date().toISOString(), summary: { actor_id: actorId, actor_input: actorInput, source_lane: sourceLane, source_name: sourceName } };

  if (!spendCheck.allowed) {
    if (supabaseUrl && supabaseKey) await createRunRecord({ supabaseUrl, supabaseKey, record: baseRecord });
    return { ok: true, allowed: false, state: spendCheck.state, reason: spendCheck.reason, budget_current_usd: spendCheck.budgetCurrentUsd, budget_remaining_usd: spendCheck.budgetRemainingUsd, estimated_run_cost_usd: spendCheck.estimatedRunCostUsd, leadFeedCity, leadFeedNiche };
  }

  let apifyRunId = null; let apifyDatasetId = null;
  try { const run = await launchApifyRun({ apifyToken, actorId, input: actorInput }); apifyRunId = run.runId; apifyDatasetId = run.datasetId; }
  catch (err) {
    if (supabaseUrl && supabaseKey) await createRunRecord({ supabaseUrl, supabaseKey, record: { ...baseRecord, status: "failed", error: `launch_error:${err.message}` } });
    return { ok: false, allowed: true, reason: `launch_error:${err.message}`, leadFeedCity, leadFeedNiche };
  }

  if (supabaseUrl && supabaseKey) {
    await createRunRecord({ supabaseUrl, supabaseKey, record: { ...baseRecord, apify_run_id: apifyRunId, apify_dataset_id: apifyDatasetId, summary: { ...baseRecord.summary, apify_run_id: apifyRunId, apify_dataset_id: apifyDatasetId } } });
    await createLeadFeedRunRecord({ supabaseUrl, supabaseKey, niche: leadFeedNiche, city: leadFeedCity, apifyRunId, apifyDatasetId });
  }
  return { ok: true, allowed: true, state: spendCheck.state, apify: { queued: true, runId: apifyRunId, datasetId: apifyDatasetId }, spend: { reservation_id: spendCheck.reservationId, budget_remaining_usd: spendCheck.budgetRemainingUsd }, leadFeedCity, leadFeedNiche };
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed" }); }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.THOS_SUPABASE_SERVICE_KEY;
  const apifyToken = process.env.APIFY_TOKEN;
  const budgetCap = Number(process.env.SALES_DISCOVERY_APIFY_BUDGET || process.env.APIFY_MONTHLY_BUDGET_USD || "25");
  const estRunCost = Number(process.env.SALES_DISCOVERY_APIFY_EST_RUN_COST || "0.10");
  const overheadPct = Number(process.env.SALES_DISCOVERY_APIFY_OVERHEAD_PCT || "0.05");
  if (!apifyToken) { await recordHeartbeat("sales_discovery_trigger", false, { reason: "APIFY_TOKEN not configured" }); return res.status(200).json({ ok: false, allowed: false, reason: "APIFY_TOKEN not configured" }); }

  const body = typeof req.body === "string" ? safeJson(req.body) || {} : (req.body || {});
  const hasExplicitRequest = req.method === "POST" && (body.actor_id || body.actorId || (typeof body.actor_input === "object" && body.actor_input));

  // ── Scheduled / bare-call path: sweep the configured market list ──────────
  if (!hasExplicitRequest) {
    const sourceLane = "sales.discovery.apify.lead-expansion";
    const sourceName = "lead-discovery-scheduled-sweep";
    const results = [];
    for (const city of DEFAULT_MARKETS) {
      const actorInput = { searchStringsArray: DEFAULT_SEARCH_TERMS, locationQuery: city, maxCrawledPlacesPerSearch: DEFAULT_MAX_PLACES, language: "en" };
      const result = await runSingleDiscovery({ supabaseUrl, supabaseKey, apifyToken, budgetCap, estRunCost, overheadPct, actorId: DEFAULT_ACTOR_ID, actorInput, sourceLane, sourceName, sourceId: `${DEFAULT_ACTOR_ID}:${city}`, leadFeedNiche: "local SEO agencies", leadFeedCity: city });
      results.push({ city, ...result });
      if (!result.allowed) break; // budget capped -- stop sweeping, don't keep hammering a blocked guard
    }
    const sweepFailed = results.some((r) => r.ok === false);
    await recordHeartbeat("sales_discovery_trigger", !sweepFailed, { markets: results.map((r) => ({ city: r.city, ok: r.ok, allowed: r.allowed, reason: r.reason })) });
    return res.status(200).json({ ok: true, mode: "scheduled_sweep", markets: DEFAULT_MARKETS, results });
  }

  // ── Explicit single-run path (unchanged contract for existing callers) ────
  const sourceLane = normalizeText(body.source_lane || body.sourceLane || "sales.discovery.apify") || "sales.discovery.apify";
  const sourceName = normalizeText(body.source_name || body.sourceName || "apify") || "apify";
  const sourceId = normalizeText(body.source_id || body.sourceId || body.actor_id || body.actorId || "") || null;
  const actorId = normalizeText(body.actor_id || body.actorId || process.env.SALES_DISCOVERY_APIFY_ACTOR_ID || process.env.LANE2_APIFY_ACTOR_ID || "");
  const actorInput = typeof body.actor_input === "object" && body.actor_input ? body.actor_input : { searchString: normalizeText(body.searchString || body.search_string || body.query || "sales opportunities"), maxItems: Number(body.maxItems || body.max_items || process.env.SALES_DISCOVERY_APIFY_MAX_ITEMS || "50") };
  if (!actorId) return res.status(200).json({ ok: false, allowed: false, reason: "missing_actor_id" });

  const leadFeedNiche = normalizeText(body.lead_feed_niche || body.leadFeedNiche || actorInput.searchStringsArray?.[0] || actorInput.searchString || "sales discovery");
  const leadFeedCity = normalizeText(body.lead_feed_city || body.leadFeedCity || actorInput.locationQuery || "");

  const result = await runSingleDiscovery({ supabaseUrl, supabaseKey, apifyToken, budgetCap, estRunCost, overheadPct, actorId, actorInput, sourceLane, sourceName, sourceId, leadFeedNiche, leadFeedCity });
  if (!result.allowed) {
    return res.status(200).json({ ok: true, allowed: false, state: result.state, reason: result.reason, budget_current_usd: result.budget_current_usd, budget_remaining_usd: result.budget_remaining_usd, estimated_run_cost_usd: result.estimated_run_cost_usd, message: "Sales discovery trigger blocked by the shared Apify budget cap." });
  }
  if (!result.ok) return res.status(200).json({ ok: false, allowed: true, reason: result.reason });
  return res.status(200).json({ ok: true, allowed: true, state: result.state, apify: result.apify, spend: result.spend });
}

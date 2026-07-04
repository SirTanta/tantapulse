import { processBatch, summarizeCounts, normalizeText } from "../../lib/tantapulse-pipeline.mjs";

async function apiGet(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
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
  try { json = text ? JSON.parse(text) : null; } catch {}
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

async function fetchApifyDataset(datasetId, token, limit = 1000) {
  const url = new URL(`https://api.apify.com/v2/datasets/${datasetId}/items`);
  url.searchParams.set("clean", "true");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("token", token);
  const res = await fetch(url.toString());
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, text, json };
}

async function fetchQueuedRuns({ supabaseUrl, supabaseKey, table }) {
  const query = new URLSearchParams({
    select: "*",
    status: "eq.queued",
    order: "requested_at.asc",
    limit: "25",
  });
  return apiGet(`${supabaseUrl}/rest/v1/${table}?${query.toString()}`, {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
  });
}

function buildRunSummary(run, batch, notes = []) {
  return {
    run_id: run.id ?? null,
    apify_run_id: run.apify_run_id ?? null,
    apify_dataset_id: run.apify_dataset_id ?? null,
    niche: run.niche ?? null,
    city: run.city ?? null,
    cadence: run.cadence ?? null,
    source: run.source ?? "apify",
    notes,
    counts: summarizeCounts(batch),
    top_items: batch.top_items.slice(0, 3).map((row) => ({
      business_name: row.business_name,
      city: row.city,
      website: row.website,
      lead_score: row.lead_score,
      score_band: row.score_band,
      recommended_action: row.recommended_action,
      duplicate_group_id: row.duplicate_group_id,
    })),
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.THOS_SUPABASE_SERVICE_KEY;
  const apifyToken = process.env.APIFY_TOKEN;
  const rawTable = process.env.TANTAPULSE_RAW_TABLE || "lead_feed_raw_items";
  const leadsTable = process.env.TANTAPULSE_LEADS_TABLE || "lead_feed_leads";
  const runsTable = process.env.TANTAPULSE_RUNS_TABLE || "lead_feed_runs";

  const body = req.method === "POST" && req.body ? (typeof req.body === "string" ? JSON.parse(req.body) : req.body) : {};
  const manualItems = Array.isArray(body.items) ? body.items : Array.isArray(body.raw_items) ? body.raw_items : [];
  const context = {
    niche: normalizeText(body.niche || body.segment || body.searchString || ""),
    city: normalizeText(body.city || body.location || ""),
    source: normalizeText(body.source || "apify"),
    collectedAt: body.collectedAt || new Date().toISOString(),
  };

  const outputs = [];
  const notes = [];

  async function persistBatch(run, batch, sourceLabel = "manual") {
    if (!supabaseUrl || !supabaseKey) return { persisted: false, reason: "missing_supabase_env" };
    const headers = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    };
    const rawRows = batch.items.map((row) => ({
      run_id: run.id ?? null,
      apify_run_id: run.apify_run_id ?? null,
      apify_dataset_id: run.apify_dataset_id ?? null,
      source: sourceLabel,
      payload: row.raw,
      payload_hash: row.raw_item_hash,
      collected_at: row.collected_at,
      niche: row.niche,
      city: row.city,
    }));
    const leadRows = batch.items.map((row) => ({
      run_id: run.id ?? null,
      canonical_entity_id: row.canonical_entity_id,
      duplicate_group_id: row.duplicate_group_id,
      business_name: row.business_name,
      niche: row.niche,
      city: row.city,
      website: row.website,
      phone: row.phone,
      email: row.email,
      source: row.source,
      source_url: row.source_url,
      collected_at: row.collected_at,
      lead_score: row.lead_score,
      score_band: row.score_band,
      recommended_action: row.recommended_action,
      score_breakdown: row.score_breakdown,
      score_reasons: row.score_reasons,
      source_confidence: row.source_confidence,
      extraction_confidence: row.extraction_confidence,
    }));

    const rawInsert = rawRows.length
      ? await apiSend(`${supabaseUrl}/rest/v1/${rawTable}?on_conflict=payload_hash`, rawRows, headers)
      : { ok: true, status: 204, json: null };
    const leadInsert = leadRows.length
      ? await apiSend(`${supabaseUrl}/rest/v1/${leadsTable}?on_conflict=run_id,canonical_entity_id`, leadRows, headers)
      : { ok: true, status: 204, json: null };
    const summaryUpdate = run.id
      ? await apiPatch(
          `${supabaseUrl}/rest/v1/${runsTable}?id=eq.${encodeURIComponent(run.id)}`,
          {
            status: sourceLabel === "queued" ? "processed" : "processed_manual",
            processed_at: new Date().toISOString(),
            summary: buildRunSummary(run, batch, notes),
            unique_count: batch.counts.unique,
            total_count: batch.counts.total,
            high_count: batch.counts.high,
            usable_count: batch.counts.usable,
            duplicate_rate: batch.counts.duplicate_rate,
          },
          headers,
        )
      : { ok: true, status: 204, text: "" };

    return {
      persisted: Boolean(rawInsert.ok && leadInsert.ok && summaryUpdate.ok),
      rawInsert: { ok: rawInsert.ok, status: rawInsert.status },
      leadInsert: { ok: leadInsert.ok, status: leadInsert.status },
      summaryUpdate: { ok: summaryUpdate.ok, status: summaryUpdate.status },
    };
  }

  if (manualItems.length) {
    const batch = processBatch(manualItems, context);
    const run = {
      id: body.run_id || body.runId || null,
      apify_run_id: body.apify_run_id || body.apifyRunId || null,
      apify_dataset_id: body.apify_dataset_id || body.apifyDatasetId || null,
      niche: context.niche,
      city: context.city,
      cadence: body.cadence || null,
      source: context.source,
    };
    const persisted = await persistBatch(run, batch, "manual");
    return res.status(200).json({ ok: true, mode: "manual", summary: buildRunSummary(run, batch, []), persisted });
  }

  if (!supabaseUrl || !supabaseKey) {
    return res.status(200).json({ ok: true, mode: "idle", note: "No Supabase configured" });
  }

  const queued = await fetchQueuedRuns({ supabaseUrl, supabaseKey, table: runsTable });
  if (!queued.ok) {
    return res.status(200).json({ ok: true, mode: "idle", note: "No queued runs or queue query failed", status: queued.status });
  }

  const runs = Array.isArray(queued.json) ? queued.json : [];
  if (!runs.length) {
    return res.status(200).json({ ok: true, mode: "idle", note: "No queued runs" });
  }

  for (const run of runs) {
    const runNotes = [];
    const datasetId = run.apify_dataset_id || run.default_dataset_id || run.dataset_id || null;
    let items = Array.isArray(run.sample_items) ? run.sample_items : [];
    if (!items.length && datasetId && apifyToken) {
      const dataset = await fetchApifyDataset(datasetId, apifyToken, Number(process.env.APIFY_DATASET_LIMIT || 1000));
      if (dataset.ok && Array.isArray(dataset.json)) {
        items = dataset.json;
      } else {
        runNotes.push(`dataset_fetch_failed:${run.id || datasetId}`);
        notes.push(`dataset_fetch_failed:${run.id || datasetId}`);
        continue;
      }
    }
    if (!items.length) {
      runNotes.push(`no_items:${run.id || datasetId || "unknown"}`);
      notes.push(`no_items:${run.id || datasetId || "unknown"}`);
      continue;
    }
    const batch = processBatch(items, {
      niche: run.niche || context.niche,
      city: run.city || context.city,
      source: run.source || "apify",
      collectedAt: run.requested_at || context.collectedAt,
    });
    const persisted = await persistBatch(run, batch, "queued");
    outputs.push({
      ...buildRunSummary(run, batch, runNotes),
      persisted,
    });
  }

  return res.status(200).json({ ok: true, mode: "queue", processed: outputs.length, outputs, notes });
}

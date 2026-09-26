/**
 * GET|POST /api/sample-intake/fulfill
 *
 * The agentic Pulse loop, one idempotent pass per call:
 *   1. queued market-check requests  -> Apify Google Places scrape
 *   2. active paid subscribers due a weekly feed -> Apify scrape
 *   3. finished scrapes -> scored, deduped leads
 *   4. scored runs -> market-check email (with plan links) or paid weekly feed
 *
 * Auth: Authorization: Bearer $CRON_SECRET (Vercel cron sends this). Fails closed.
 */
import {
  APIFY_ACTOR, FROM, OPS_EMAIL, PAID_DELIVERY_COUNT, PLACES_PER_SCRAPE, REPLY_TO, SAMPLE_PREVIEW_COUNT,
  isStale, isTestRequest, rankLeads, renderMarketCheck, renderPaidDelivery, searchString, unsubHeaders,
  OUTREACH_DAILY_CAP, OUTREACH_FROM, OUTREACH_PASS_CAP, OUTREACH_REPLY_TO, SEO_DISCOVERY_CUTOVER, inOutreachWindow, renderOutreach,
} from "../../lib/pulse-fulfillment.mjs";

const MAX_STARTS_PER_PASS = 5;
const WEEK_MS = 6.5 * 86400000;
const SCRAPE_TIMEOUT_MS = 2 * 3600000;
const LOOP_SOURCES = "(sample_intake,paid_weekly)";

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.THOS_SUPABASE_SERVICE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  async function call(method, path, body, extra = {}) {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      method,
      headers: { ...headers, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* noop */ }
    if (!res.ok) throw new Error(`db ${method} ${path.split("?")[0]} ${res.status}: ${text.slice(0, 200)}`);
    return json;
  }
  return {
    ok: Boolean(url && key),
    get: (p) => call("GET", p),
    insert: (p, b) => call("POST", p, b, { Prefer: "return=representation" }),
    patch: (p, b) => call("PATCH", p, b, { Prefer: "return=minimal" }),
    del: (p) => call("DELETE", p),
  };
}

async function apify(method, path, body) {
  const res = await fetch(`https://api.apify.com/v2/${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`apify ${path.split("?")[0]} ${res.status}`);
  return json;
}

async function apifyBudgetOk() {
  const cap = Number(process.env.APIFY_MONTHLY_BUDGET_USD || 25);
  const { data } = await apify("GET", "users/me/limits");
  const used = Number(data?.current?.monthlyUsageUsd || 0);
  return { ok: used < cap * 0.9, used, cap };
}

async function sendEmail({ to, subject, html, unsub = true, from = FROM, replyTo = REPLY_TO }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, reply_to: replyTo, subject, html, headers: unsub ? unsubHeaders(to) : undefined }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`resend ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json.id;
}

async function opsAlert(subject, lines) {
  try {
    await sendEmail({ to: OPS_EMAIL, subject: `[Pulse ops] ${subject}`, html: `<pre style="font-family:monospace">${lines.join("\n").replace(/</g, "&lt;")}</pre>`, unsub: false });
  } catch (err) {
    console.error("[fulfill] ops alert failed", err.message);
  }
}

async function isUnsubscribed(d, email) {
  const rows = await d.get(`lead_feed_unsubscribes?email=eq.${encodeURIComponent(email.toLowerCase())}&select=email`);
  return rows.length > 0;
}

async function startScrape(d, { source, name, email, niche, city, cadence, notes }) {
  const run = await apify("POST", `acts/${APIFY_ACTOR}/runs?waitForFinish=0`, {
    searchStringsArray: [searchString(niche, city)],
    maxCrawledPlacesPerSearch: PLACES_PER_SCRAPE,
    language: "en",
    skipClosedPlaces: true,
  });
  const [row] = await d.insert("lead_feed_runs", {
    status: "scraping",
    source,
    request_name: name || null,
    request_email: email,
    niche,
    city,
    cadence: cadence || "weekly",
    notes,
    apify_run_id: run.data.id,
    apify_dataset_id: run.data.defaultDatasetId,
  });
  return row.id;
}

async function startIntakes(d, log, budget) {
  const rows = await d.get("sample_intake_requests?status=eq.queued&order=created_at.asc&limit=20&select=id,receipt_id,created_at,request_name,request_email,niche,city,cadence");
  let started = 0;
  for (const r of rows) {
    let status = null;
    if (isTestRequest(r)) status = "skipped_test";
    else if (isStale(r.created_at)) status = "expired_backlog";
    else if (await isUnsubscribed(d, r.request_email)) status = "skipped_unsubscribed";
    if (status) {
      await d.patch(`sample_intake_requests?id=eq.${r.id}`, { status, updated_at: new Date().toISOString() });
      log.push(`intake ${r.receipt_id.slice(0, 8)} -> ${status}`);
      continue;
    }
    if (!budget.ok || started >= MAX_STARTS_PER_PASS) break;
    const runId = await startScrape(d, { source: "sample_intake", name: r.request_name, email: r.request_email, niche: r.niche, city: r.city, cadence: r.cadence, notes: `intake:${r.id}` });
    await d.patch(`sample_intake_requests?id=eq.${r.id}`, { status: "scraping", updated_at: new Date().toISOString() });
    log.push(`intake ${r.receipt_id.slice(0, 8)} -> scraping run ${runId}`);
    started++;
  }
  return started;
}

async function startPaid(d, log, budget, alreadyStarted) {
  const subs = await d.get("paid_subscribers?subscription_status=eq.active&niche=not.is.null&city=not.is.null&select=id,email,name,monetization_tier,niche,city,last_delivered_at");
  let started = alreadyStarted;
  for (const s of subs) {
    if (s.last_delivered_at && Date.now() - new Date(s.last_delivered_at).getTime() < WEEK_MS) continue;
    const inflight = await d.get(`lead_feed_runs?source=eq.paid_weekly&request_email=eq.${encodeURIComponent(s.email)}&status=in.(scraping,processed)&select=id`);
    if (inflight.length) continue;
    if (await isUnsubscribed(d, s.email)) continue;
    if (!budget.ok || started >= MAX_STARTS_PER_PASS) break;
    const runId = await startScrape(d, { source: "paid_weekly", name: s.name, email: s.email, niche: s.niche, city: s.city, notes: `tier:${s.monetization_tier};sub:${s.id}` });
    log.push(`paid ${s.monetization_tier} sub ${s.id.slice(0, 8)} -> scraping run ${runId}`);
    started++;
  }
}

async function priorEntityIds(d, email) {
  const runs = await d.get(`lead_feed_runs?request_email=eq.${encodeURIComponent(email)}&source=in.${LOOP_SOURCES}&status=eq.delivered&select=id`);
  if (!runs.length) return new Set();
  const leads = await d.get(`lead_feed_leads?run_id=in.(${runs.map((r) => r.id).join(",")})&select=canonical_entity_id`);
  return new Set(leads.map((l) => l.canonical_entity_id));
}

async function collect(d, log) {
  const runs = await d.get(`lead_feed_runs?status=eq.scraping&source=in.${LOOP_SOURCES}&select=*`);
  for (const run of runs) {
    const { data } = await apify("GET", `actor-runs/${run.apify_run_id}`);
    if (data.status === "RUNNING" || data.status === "READY") {
      if (Date.now() - new Date(run.created_at).getTime() < SCRAPE_TIMEOUT_MS) continue;
      data.status = "TIMED-OUT";
    }
    if (data.status !== "SUCCEEDED") {
      await d.patch(`lead_feed_runs?id=eq.${run.id}`, { status: "failed", summary: { apify_status: data.status } });
      await markIntake(d, run, "failed");
      await opsAlert(`scrape ${data.status}`, [`run ${run.id}`, `source ${run.source}`, `${run.niche} in ${run.city}`, "Reply to the requester by hand."]);
      log.push(`run ${run.id} -> failed (${data.status})`);
      continue;
    }
    const places = await apify("GET", `datasets/${run.apify_dataset_id}/items?clean=true&format=json&limit=200`);
    const exclude = await priorEntityIds(d, run.request_email);
    const ranked = rankLeads(Array.isArray(places) ? places : [], { runId: run.id, niche: run.niche, city: run.city }, exclude);
    const keep = ranked.slice(0, run.source === "paid_weekly" ? PAID_DELIVERY_COUNT : SAMPLE_PREVIEW_COUNT);
    if (keep.length) await d.insert("lead_feed_leads?on_conflict=run_id,canonical_entity_id", keep);
    await d.patch(`lead_feed_runs?id=eq.${run.id}`, {
      status: "processed",
      processed_at: new Date().toISOString(),
      total_count: Array.isArray(places) ? places.length : 0,
      unique_count: ranked.length,
      high_count: ranked.filter((l) => l.score_band === "high").length,
      usable_count: ranked.filter((l) => l.score_band === "usable").length,
    });
    log.push(`run ${run.id} -> processed (${keep.length} kept of ${ranked.length})`);
  }
}

async function markIntake(d, run, status) {
  const m = /^intake:([0-9a-f-]{36})$/.exec(run.notes || "");
  if (m) await d.patch(`sample_intake_requests?id=eq.${m[1]}`, { status, updated_at: new Date().toISOString() });
}

async function deliver(d, log) {
  const runs = await d.get(`lead_feed_runs?status=eq.processed&source=in.${LOOP_SOURCES}&select=*`);
  for (const run of runs) {
    const leads = await d.get(`lead_feed_leads?run_id=eq.${run.id}&order=lead_score.desc&select=business_name,phone,website,lead_score,score_band,score_reasons`);
    if (await isUnsubscribed(d, run.request_email)) {
      await d.patch(`lead_feed_runs?id=eq.${run.id}`, { status: "skipped_unsubscribed" });
      await markIntake(d, run, "skipped_unsubscribed");
      continue;
    }
    if (!leads.length) {
      await d.patch(`lead_feed_runs?id=eq.${run.id}`, { status: "failed_empty" });
      await markIntake(d, run, "needs_human");
      await opsAlert("no leads found", [`run ${run.id}`, `${run.source}: ${run.niche} in ${run.city}`, "Reply to the requester by hand."]);
      log.push(`run ${run.id} -> failed_empty`);
      continue;
    }
    const tier = /tier:(\w+)/.exec(run.notes || "")?.[1];
    const msg = run.source === "paid_weekly"
      ? renderPaidDelivery({ name: run.request_name, email: run.request_email, niche: run.niche, city: run.city, leads, tier })
      : renderMarketCheck({ name: run.request_name, email: run.request_email, niche: run.niche, city: run.city, leads, totalFound: run.unique_count || leads.length });
    const emailId = await sendEmail({ to: run.request_email, ...msg });
    const now = new Date().toISOString();
    await d.patch(`lead_feed_runs?id=eq.${run.id}`, { status: "delivered", summary: { ...(run.summary || {}), resend_id: emailId, delivered_at: now } });
    if (run.source === "paid_weekly") {
      const sub = /sub:([0-9a-f-]{36})/.exec(run.notes || "")?.[1];
      if (sub) await d.patch(`paid_subscribers?id=eq.${sub}`, { last_delivered_at: now });
    } else {
      await markIntake(d, run, "delivered");
    }
    await opsAlert(`${run.source === "paid_weekly" ? "paid feed" : "market check"} sent`, [`to ${run.request_email}`, `${run.niche} in ${run.city}`, `${leads.length} leads`, `resend ${emailId}`]);
    log.push(`run ${run.id} -> delivered (${emailId})`);
  }
}


async function isSuppressed(d, email) {
  const domain = email.split("@")[1] || "";
  if (await isUnsubscribed(d, email)) return true;
  const rows = await d.get(`tanta_pulse_suppressions?or=(email.ilike.${encodeURIComponent(email)},domain.ilike.${encodeURIComponent(domain)})&select=id&limit=1`);
  return rows.length > 0;
}

async function eligibleOutreach(d, limit) {
  const rows = await d.get(
    "leads?select=id,company,domain,contact:contacts!inner(email)" +
    "&outreach_status=in.(pending,eligible)&outreach_sequence=eq.0&hunter_confidence=gte.80&hunter_verifier_status=ilike.valid" +
    `&or=(source.eq.tantapulse_seo_agency,and(source.eq.apify,created_at.gte.${SEO_DISCOVERY_CUTOVER}))` +
    `&order=created_at.asc&limit=${limit}`
  );
  return rows.filter((r) => r.contact?.email);
}

async function outreach(d, log, { preview = false } = {}) {
  if (preview) {
    const [lead] = await eligibleOutreach(d, 1);
    if (!lead) { log.push("outreach preview: no eligible lead yet"); return; }
    const msg = renderOutreach({ company: lead.company, email: lead.contact.email });
    const id = await sendEmail({ to: OUTREACH_REPLY_TO, subject: `[PREVIEW to ${lead.contact.email.split("@")[1]}] ${msg.subject}`, html: msg.html, from: OUTREACH_FROM, replyTo: OUTREACH_REPLY_TO, unsub: false });
    log.push(`outreach preview sent to Jon (${id})`);
    return;
  }
  if (!inOutreachWindow()) return;
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const today = await d.get(`pulse_outreach_sends?sent_at=gte.${since.toISOString()}&select=id`);
  const room = Math.min(OUTREACH_PASS_CAP, OUTREACH_DAILY_CAP - today.length);
  if (room <= 0) return;
  for (const lead of await eligibleOutreach(d, room)) {
    const email = lead.contact.email.toLowerCase();
    if (await isSuppressed(d, email)) {
      await d.patch(`leads?id=eq.${lead.id}`, { outreach_status: "suppressed", updated_at: new Date().toISOString() });
      continue;
    }
    const [claim] = await d.insert("pulse_outreach_sends", { lead_id: lead.id, email });
    let id;
    try {
      const msg = renderOutreach({ company: lead.company, email });
      id = await sendEmail({ to: email, ...msg, from: OUTREACH_FROM, replyTo: OUTREACH_REPLY_TO });
    } catch (err) {
      await d.del(`pulse_outreach_sends?id=eq.${claim.id}`);
      throw err;
    }
    await d.patch(`pulse_outreach_sends?id=eq.${claim.id}`, { resend_id: id });
    await d.patch(`leads?id=eq.${lead.id}`, { outreach_status: "emailed", outreach_sequence: 1, updated_at: new Date().toISOString() });
    log.push(`outreach -> ${lead.domain} (${id})`);
  }
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const d = db();
  if (!d.ok || !process.env.APIFY_TOKEN || !process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: "Missing configuration" });
  }
  const log = [];
  const errors = [];
  const step = async (name, fn) => {
    try { await fn(); } catch (err) { errors.push(`${name}: ${err.message}`); }
  };
  let budget = { ok: false };
  await step("budget", async () => { budget = await apifyBudgetOk(); });
  if (!budget.ok && budget.used !== undefined) log.push(`apify budget hold: $${budget.used.toFixed(2)} of $${budget.cap}`);
  let started = 0;
  await step("intake", async () => { started = await startIntakes(d, log, budget); });
  await step("paid", () => startPaid(d, log, budget, started));
  await step("collect", () => collect(d, log));
  await step("deliver", () => deliver(d, log));
  await step("outreach", () => outreach(d, log, { preview: req.query?.outreach_preview === "1" }));
  if (errors.length) await opsAlert("fulfill errors", errors);
  return res.status(errors.length ? 500 : 200).json({ ok: !errors.length, log, errors });
}

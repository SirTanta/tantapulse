const ALLOWED_ORIGINS = new Set([
  "https://tantapulse.com",
  "https://www.tantapulse.com",
  "http://localhost:3000",
  "http://localhost:3001",
]);

const FOLLOWUP_STEPS = [
  { step: 0, delayDays: 0, subject: "Your Tanta Pulse sample request is in" },
  { step: 1, delayDays: 2, subject: "Want a tighter niche for your sample feed?" },
  { step: 2, delayDays: 5, subject: "Here’s how we rank the leads" },
  { step: 3, delayDays: 10, subject: "Ready for a sample feed?" },
];

function esc(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function originAllowed(req) {
  const origin = req.headers.origin || req.headers.referer || "";
  if (!origin) return true;
  try {
    return ALLOWED_ORIGINS.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, text, json: parsed };
}

async function deleteJson(url, headers = {}) {
  const res = await fetch(url, { method: "DELETE", headers });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function apiGet(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, text, json };
}

const APIFY_RATE_ACTION = "tantapulse_apify_run";

async function checkAndReserveApifyRun({ supabaseUrl, supabaseKey, email }) {
  const dailyCap = Number.parseInt(process.env.APIFY_DAILY_RUN_CAP || "20", 10) || 20;
  if (!supabaseUrl || !supabaseKey) return { allowed: true };

  try {
    const headers = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Prefer: "return=minimal",
    };
    const windowStart = new Date();
    windowStart.setUTCHours(0, 0, 0, 0);
    const windowIso = windowStart.toISOString();

    const query = new URLSearchParams({
      select: "identifier,count",
      action: `eq.${APIFY_RATE_ACTION}`,
      window_start: `eq.${windowIso}`,
    });
    const { ok, json } = await apiGet(`${supabaseUrl}/rest/v1/rate_limits?${query.toString()}`, headers);
    const rows = ok && Array.isArray(json) ? json : [];

    const globalCount = rows.filter((r) => r.identifier === "global").reduce((sum, r) => sum + Number(r.count || 0), 0);
    const alreadyRunToday = rows.some((r) => r.identifier === email);

    if (globalCount >= dailyCap || alreadyRunToday) {
      return { allowed: false, reason: alreadyRunToday ? "email_already_ran_today" : "daily_cap_reached" };
    }

    await postJson(`${supabaseUrl}/rest/v1/rate_limits?on_conflict=identifier,action,window_start`, [
      { identifier: "global", action: APIFY_RATE_ACTION, window_start: windowIso, count: globalCount + 1 },
      { identifier: email, action: APIFY_RATE_ACTION, window_start: windowIso, count: 1 },
    ], { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" });

    return { allowed: true };
  } catch (err) {
    console.error("[Tanta Pulse] rate limit check failed, failing open:", err);
    return { allowed: true };
  }
}

async function startApifySearch({ niche, city, maxCrawledPlaces = 10 }) {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { enabled: false };

  const actorId = process.env.APIFY_GOOGLE_PLACES_ACTOR_ID || "nwua9Gu5YrADL7ZDj";
  const payload = {
    searchString: `${niche} in ${city}`,
    proxyConfig: { useApifyProxy: true },
    maxCrawledPlaces,
  };

  const res = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/runs?token=${encodeURIComponent(token)}&waitForFinish=0`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, text, json };
}

function renderInternalHtml({ name, email, niche, city, cadence, notes, apifyRunId }) {
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0b1020;margin:0;padding:0">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#101936;border:1px solid rgba(241,198,106,0.18);border-radius:16px;overflow:hidden;max-width:600px;width:100%">
      <tr><td style="padding:22px 28px;background:linear-gradient(135deg,#0b1020,#101936);border-bottom:1px solid rgba(241,198,106,0.18)">
        <span style="color:#f1c66a;font-size:18px;font-weight:900;letter-spacing:0.08em">TANTA PULSE</span>
        <span style="color:rgba(255,255,255,0.45);font-size:12px;margin-left:10px;text-transform:uppercase;letter-spacing:0.18em">Sample Request</span>
      </td></tr>
      <tr><td style="padding:28px">
        <p style="margin:0 0 12px;color:#fff;font-size:22px;font-weight:800">New request received</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="color:rgba(255,255,255,0.82);font-size:14px;line-height:1.7">
          <tr><td style="padding-bottom:8px"><strong>Name:</strong> ${esc(name)}</td></tr>
          <tr><td style="padding-bottom:8px"><strong>Email:</strong> <a href="mailto:${esc(email)}" style="color:#f1c66a">${esc(email)}</a></td></tr>
          <tr><td style="padding-bottom:8px"><strong>Niche:</strong> ${esc(niche)}</td></tr>
          <tr><td style="padding-bottom:8px"><strong>City:</strong> ${esc(city)}</td></tr>
          <tr><td style="padding-bottom:8px"><strong>Cadence:</strong> ${esc(cadence)}</td></tr>
          ${notes ? `<tr><td style="padding-bottom:8px"><strong>Notes:</strong><br>${esc(notes).replace(/\n/g, "<br>")}</td></tr>` : ""}
        </table>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

function renderAckHtml({ name, niche, city, cadence }) {
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0b1020;margin:0;padding:0">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#101936;border:1px solid rgba(241,198,106,0.18);border-radius:16px;overflow:hidden;max-width:600px;width:100%">
      <tr><td style="padding:22px 28px;background:linear-gradient(135deg,#0b1020,#101936);border-bottom:1px solid rgba(241,198,106,0.18)">
        <span style="color:#f1c66a;font-size:18px;font-weight:900;letter-spacing:0.08em">TANTA PULSE</span>
        <span style="color:rgba(255,255,255,0.45);font-size:12px;margin-left:10px;text-transform:uppercase;letter-spacing:0.18em">Request Confirmed</span>
      </td></tr>
      <tr><td style="padding:28px">
        <p style="margin:0 0 10px;color:#fff;font-size:24px;font-weight:900;letter-spacing:-0.03em">Thanks, ${esc(name)}.</p>
        <p style="margin:0 0 18px;color:rgba(255,255,255,0.75);font-size:15px;line-height:1.7">
          We got your sample request for <strong>${esc(niche)}</strong> in <strong>${esc(city)}</strong> on a <strong>${esc(cadence)}</strong> cadence.
        </p>
        <p style="margin:0;color:rgba(255,255,255,0.72);font-size:15px;line-height:1.7">
          We’re queueing the sample and follow-up sequence now. If we need anything else, we’ll reply to this email.
        </p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

export default async function handler(req, res) {
  if (!originAllowed(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const niche = String(body.niche || "").trim();
  const city = String(body.city || "").trim();
  const cadence = String(body.cadence || "weekly").trim();
  const notes = String(body.notes || "").trim();

  if (!name || !email || !niche || !city || !isEmail(email)) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.THOS_SUPABASE_SERVICE_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const source = `tantapulse_sample:${niche}:${city}:${cadence}`;
  const timestamp = new Date().toISOString();

  const result = { saved: false, notified: false, confirmed: false, sequence: false };

  if (supabaseUrl && supabaseKey) {
    const headers = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Prefer: "return=minimal",
    };
    try {
      await postJson(
        `${supabaseUrl}/rest/v1/newsletter_subscribers?on_conflict=email`,
        [{ email, name, subscribed_at: timestamp, source }],
        { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
      );
      result.saved = true;
    } catch (err) {
      console.error("[Tanta Pulse] newsletter_subscribers write failed:", err);
    }

    try {
      await deleteJson(
        `${supabaseUrl}/rest/v1/email_sequence?email=eq.${encodeURIComponent(email)}&funnel=eq.tantapulse_sample`,
        headers,
      );
      const rows = FOLLOWUP_STEPS.map(({ step, delayDays }) => ({
        email,
        name,
        funnel: "tantapulse_sample",
        step,
        scheduled_for: new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000).toISOString(),
      }));
      await postJson(`${supabaseUrl}/rest/v1/email_sequence`, rows, headers);
      result.sequence = true;
    } catch (err) {
      console.error("[Tanta Pulse] email_sequence write failed:", err);
    }
  }

  try {
    const reservation = await checkAndReserveApifyRun({ supabaseUrl, supabaseKey, email });
    if (!reservation.allowed) {
      result.apify = { queued: false, reason: reservation.reason };
      throw new Error("apify_capped");
    }

    const maxCrawledPlaces = Number.parseInt(process.env.APIFY_MAX_CRAWLED_PLACES || "10", 10) || 10;
    const apify = await startApifySearch({ niche, city, maxCrawledPlaces });
    if (apify?.ok) {
      const runId = apify.json?.data?.id || null;
      const defaultDatasetId = apify.json?.data?.defaultDatasetId || null;
      result.apify = {
        queued: true,
        runId,
        defaultDatasetId,
      };

      if (supabaseUrl && supabaseKey) {
        try {
          const runRecord = [{
            request_name: name,
            request_email: email,
            niche,
            city,
            cadence,
            notes,
            source,
            status: "queued",
            apify_run_id: runId,
            apify_dataset_id: defaultDatasetId,
            requested_at: timestamp,
          }];
          const runInsert = await postJson(`${supabaseUrl}/rest/v1/lead_feed_runs`, runRecord, {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            Prefer: "resolution=merge-duplicates,return=minimal",
          });
          if (runInsert.ok) {
            result.pipeline = { queued: true };
          } else {
            result.pipeline = {
              queued: false,
              status: runInsert.status,
              error: "lead_feed_runs insert failed",
            };
            console.error("[Tanta Pulse] lead_feed_runs insert failed:", runInsert.status, runInsert.text);
          }
        } catch (runErr) {
          console.error("[Tanta Pulse] lead_feed_runs insert failed:", runErr);
        }
      }
    }
  } catch (err) {
    console.error("[Tanta Pulse] apify queue failed:", err);
  }

  if (resendKey) {
    try {
      await postJson("https://api.resend.com/emails", {
        from: "Tanta Pulse <noreply@tantaholdings.com>",
        to: "hello@tantapulse.com",
        reply_to: email,
        subject: `[Tanta Pulse] Sample request: ${niche} in ${city}`,
        html: renderInternalHtml({ name, email, niche, city, cadence, notes }),
      }, {
        Authorization: `Bearer ${resendKey}`,
      });
      result.notified = true;
    } catch (err) {
      console.error("[Tanta Pulse] internal email failed:", err);
    }

    try {
      await postJson("https://api.resend.com/emails", {
        from: "Tanta Pulse <noreply@tantaholdings.com>",
        to: email,
        subject: "Your Tanta Pulse sample request is in",
        html: renderAckHtml({ name, niche, city, cadence }),
      }, {
        Authorization: `Bearer ${resendKey}`,
      });
      result.confirmed = true;
    } catch (err) {
      console.error("[Tanta Pulse] confirmation email failed:", err);
    }
  }

  return res.status(200).json({ ok: true, ...result });
}

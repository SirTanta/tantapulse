/**
 * POST /api/lead-feed/deliver-sample
 *
 * Sends a branded sample delivery email to the customer who submitted a
 * sample request. The email includes their scored lead list rendered as
 * a clean HTML table.
 *
 * Body (JSON):
 *   run_id    — optional; defaults to the most recent processed run
 *   limit     — optional; max leads to include (default 50, cap 100)
 *   test      — optional; if "true", sends to hello@tantapulse.com instead
 *               of the requester, and skips run status update (for QA preview)
 *
 * Auth: X-Webhook-Secret header must match RESEND_WEBHOOK_SECRET env var
 *       (set to a random value; empty = auth disabled for internal testing)
 *
 * Env vars required:
 *   RESEND_API_KEY
 *   THOS_SUPABASE_URL, THOS_SUPABASE_SERVICE_KEY
 *   RESEND_WEBHOOK_SECRET  (optional; empty = open for internal use)
 */

const STEP_COPY = {
  subject: "Your Tanta Pulse sample is ready — Austin TX local SEO agencies",
  headline: "Your sample lead feed is ready",
  subheadline: (name) =>
    name
      ? `Hi ${name}, here's your curated sample of Austin TX local SEO agency leads.`
      : "Here's your curated sample of Austin TX local SEO agencies.",
};

const STRIPE_PLANS = [
  { name: "Starter", price: "$49/mo", url: "https://buy.stripe.com/aFa00c74H8i0ghZ12j5J605" },
  { name: "Pro", price: "$149/mo", url: "https://buy.stripe.com/4gMdR274HeGo5Dl3ar5J606" },
  { name: "Agency", price: "$399/mo", url: "https://buy.stripe.com/aFadR2cp1bucghZfXd5J607" },
];

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderUpsellHtml({ name }) {
  const greeting = name ? `Hi ${esc(name)},` : "Hi there,";
  const plans = STRIPE_PLANS.map((plan) => `
    <tr><td style="padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.08)">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="color:#fff;font-size:16px;font-weight:800">${plan.name} <span style="color:rgba(255,255,255,0.58);font-weight:500">${plan.price}</span></td>
        <td align="right"><a href="${plan.url}" style="display:inline-block;background:#f1c66a;border-radius:6px;color:#101936;font-size:13px;font-weight:800;padding:9px 14px;text-decoration:none">Choose ${plan.name}</a></td>
      </tr></table>
    </td></tr>`).join("");

  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0b1020;margin:0;padding:0">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#101936;border:1px solid rgba(241,198,106,0.18);border-radius:16px;overflow:hidden;max-width:600px;width:100%">
      <tr><td style="padding:22px 28px;background:linear-gradient(135deg,#0b1020,#101936);border-bottom:1px solid rgba(241,198,106,0.18)"><span style="color:#f1c66a;font-size:18px;font-weight:900;letter-spacing:0.08em">TANTA PULSE</span><span style="color:rgba(255,255,255,0.45);font-size:12px;margin-left:10px;text-transform:uppercase;letter-spacing:0.18em">Continue your feed</span></td></tr>
      <tr><td style="padding:28px">
        <p style="margin:0 0 12px;color:#fff;font-size:22px;font-weight:800">Ready for your recurring lead feed?</p>
        <p style="margin:0 0 20px;color:rgba(255,255,255,0.78);font-size:15px;line-height:1.7">${greeting} choose the plan that fits your outreach volume. Your paid feed starts with the same scored, deduped leads you just received.</p>
        <table width="100%" cellpadding="0" cellspacing="0">${plans}</table>
      </td></tr>
      <tr><td style="padding:16px 28px 28px;color:rgba(255,255,255,0.48);font-size:12px;line-height:1.6">Tanta Holdings LLC &middot; <a href="https://tantapulse.com/unsubscribe" style="color:rgba(241,198,106,0.7)">Unsubscribe</a> &middot; <a href="mailto:hello@tantapulse.com" style="color:rgba(255,255,255,0.35)">hello@tantapulse.com</a></td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

function scoreBand(score) {
  if (score >= 80) return { label: "High Priority", color: "#22c55e", bg: "rgba(34,197,94,0.12)" };
  if (score >= 50) return { label: "Usable",       color: "#f1c66a", bg: "rgba(241,198,106,0.12)" };
  return                        { label: "Low Priority", color: "rgba(255,255,255,0.4)", bg: "rgba(255,255,255,0.04)" };
}

function renderLeadRow(lead, index) {
  const band = scoreBand(lead.lead_score ?? 0);
  const website = lead.website
    ? `<a href="${esc(lead.website)}" style="color:#f1c66a;text-decoration:none">${esc(lead.website)}</a>`
    : '<span style="color:rgba(255,255,255,0.3)">—</span>';
  const phone  = lead.phone
    ? `<a href="tel:${esc(String(lead.phone).replace(/\s+/g,""))}" style="color:rgba(255,255,255,0.75);text-decoration:none">${esc(lead.phone)}</a>`
    : '<span style="color:rgba(255,255,255,0.3)">—</span>';
  return `<tr style="border-bottom:1px solid rgba(255,255,255,0.06)">
  <td style="padding:10px 14px;color:rgba(255,255,255,0.4);font-size:12px;text-align:center;width:28px">${index}</td>
  <td style="padding:10px 14px">
    <div style="color:#fff;font-size:14px;font-weight:600;margin-bottom:2px">${esc(lead.business_name ?? "—")}</div>
    <div style="color:rgba(255,255,255,0.45);font-size:12px">${esc(lead.niche ?? "")}</div>
  </td>
  <td style="padding:10px 14px;text-align:center;width:70px">
    <span style="
      display:inline-block;
      min-width:36px;
      padding:3px 8px;
      border-radius:999px;
      font-size:12px;
      font-weight:700;
      text-align:center;
      color:${band.color};
      background:${band.bg};
    ">${lead.lead_score ?? 0}</span>
  </td>
  <td style="padding:10px 14px;text-align:center;width:100px">
    <span style="
      display:inline-block;
      padding:3px 8px;
      border-radius:999px;
      font-size:11px;
      font-weight:600;
      text-transform:uppercase;
      letter-spacing:0.05em;
      color:${band.color};
      background:${band.bg};
    ">${band.label}</span>
  </td>
  <td style="padding:10px 14px;font-size:13px;color:rgba(255,255,255,0.75)">${phone}</td>
  <td style="padding:10px 14px;font-size:13px">${website}</td>
  <td style="padding:10px 14px;font-size:12px;color:rgba(255,255,255,0.38)">${esc(lead.source ?? "—")}</td>
</tr>`;
}

function renderHtml({ name, leads, runId }) {
  const total   = leads.length;
  const high    = leads.filter(l => (l.lead_score ?? 0) >= 80).length;
  const usable  = leads.filter(l => (l.lead_score ?? 0) >= 50 && (l.lead_score ?? 0) < 80).length;
  const low     = leads.filter(l => (l.lead_score ?? 0) < 50).length;
  const rows    = leads.map((lead, i) => renderLeadRow(lead, i + 1)).join("\n");

  return `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0b1020;margin:0;padding:0">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:40px 16px">

      <!-- ── Header ── -->
      <table width="600" cellpadding="0" cellspacing="0" style="background:#101936;border:1px solid rgba(241,198,106,0.18);border-radius:16px 16px 0 0;overflow:hidden;max-width:600px;width:100%">
        <tr>
          <td style="padding:22px 28px;background:linear-gradient(135deg,#0b1020,#101936);border-bottom:1px solid rgba(241,198,106,0.18)">
            <span style="color:#f1c66a;font-size:18px;font-weight:900;letter-spacing:0.08em">TANTA PULSE</span>
            <span style="color:rgba(255,255,255,0.45);font-size:12px;margin-left:10px;text-transform:uppercase;letter-spacing:0.18em">Sample Delivery</span>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 28px 20px">
            <p style="margin:0 0 8px;color:#fff;font-size:22px;font-weight:800">${esc(STEP_COPY.headline)}</p>
            <p style="margin:0 0 20px;color:rgba(255,255,255,0.72);font-size:15px;line-height:1.6">${esc(STEP_COPY.subheadline(name))}</p>

            <!-- ── Stats row ── -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:4px">
              <tr>
                <td style="padding:12px 14px;background:rgba(34,197,94,0.1);border-radius:8px;text-align:center;width:33%">
                  <div style="color:#22c55e;font-size:22px;font-weight:800">${high}</div>
                  <div style="color:rgba(255,255,255,0.5);font-size:11px;text-transform:uppercase;letter-spacing:0.08em">High Priority</div>
                </td>
                <td style="padding:12px 8px;text-align:center;width:34%">
                  <div style="color:#f1c66a;font-size:22px;font-weight:800">${usable}</div>
                  <div style="color:rgba(255,255,255,0.5);font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Usable</div>
                </td>
                <td style="padding:12px 14px;background:rgba(255,255,255,0.04);border-radius:8px;text-align:center;width:33%">
                  <div style="color:rgba(255,255,255,0.35);font-size:22px;font-weight:800">${low}</div>
                  <div style="color:rgba(255,255,255,0.35);font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Low Priority</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

      <!-- ── Lead table ── -->
      <table width="600" cellpadding="0" cellspacing="0" style="background:#0f1829;border-left:1px solid rgba(241,198,106,0.18);border-right:1px solid rgba(241,198,106,0.18);max-width:600px;width:100%">
        <!-- column headers -->
        <thead>
          <tr style="background:rgba(255,255,255,0.03)">
            <th style="padding:8px 14px;color:rgba(255,255,255,0.35);font-size:11px;text-align:center;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;width:28px">#</th>
            <th style="padding:8px 14px;color:rgba(255,255,255,0.35);font-size:11px;text-align:left;font-weight:600;text-transform:uppercase;letter-spacing:0.08em">Agency</th>
            <th style="padding:8px 14px;color:rgba(255,255,255,0.35);font-size:11px;text-align:center;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;width:70px">Score</th>
            <th style="padding:8px 14px;color:rgba(255,255,255,0.35);font-size:11px;text-align:center;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;width:100px">Priority</th>
            <th style="padding:8px 14px;color:rgba(255,255,255,0.35);font-size:11px;text-align:left;font-weight:600;text-transform:uppercase;letter-spacing:0.08em">Phone</th>
            <th style="padding:8px 14px;color:rgba(255,255,255,0.35);font-size:11px;text-align:left;font-weight:600;text-transform:uppercase;letter-spacing:0.08em">Website</th>
            <th style="padding:8px 14px;color:rgba(255,255,255,0.35);font-size:11px;text-align:left;font-weight:600;text-transform:uppercase;letter-spacing:0.08em">Source</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>

      <!-- ── Footer ── -->
      <table width="600" cellpadding="0" cellspacing="0" style="background:#0f1829;border:1px solid rgba(241,198,106,0.18);border-top:none;border-radius:0 0 16px 16px;overflow:hidden;max-width:600px;width:100%">
        <tr>
          <td style="padding:20px 28px">
            <p style="margin:0 0 12px;color:rgba(255,255,255,0.6);font-size:13px;line-height:1.7">
              All leads are scored on a 0–100 scale. High Priority (80+) leads are ready for immediate outreach.
              Usable leads (50–79) are worth a follow-up. Low Priority leads are included for completeness but may need additional research before contacting.
            </p>
            <p style="margin:0 0 16px;color:rgba(255,255,255,0.55);font-size:13px;line-height:1.7">
              To turn this into a recurring weekly feed, reply to this email or visit
              <a href="https://tantapulse.com/pricing" style="color:#f1c66a;text-decoration:none">tantapulse.com/pricing</a>.
            </p>
            <p style="margin:0;color:rgba(255,255,255,0.38);font-size:12px;line-height:1.6">
              Tanta Holdings LLC &middot; Austin TX &middot;
              <a href="https://tantapulse.com/unsubscribe" style="color:rgba(241,198,106,0.7)">Unsubscribe</a>
              &nbsp;&middot;&nbsp;
              <a href="mailto:hello@tantapulse.com" style="color:rgba(255,255,255,0.35)">hello@tantapulse.com</a>
            </p>
          </td>
        </tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function apiGet(url, headers = {}) {
  const res  = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* noop */ }
  return { ok: res.ok, status: res.status, text, json };
}

async function apiPatch(url, body, headers = {}) {
  const res  = await fetch(url, {
    method:  "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* noop */ }
  return { ok: res.ok, status: res.status, text, json };
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret    = process.env.RESEND_WEBHOOK_SECRET ?? "";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL;
  const supabaseKey  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.THOS_SUPABASE_SERVICE_KEY;
  const resendKey    = process.env.RESEND_API_KEY;

  // ── Auth ──────────────────────────────────────────────────────────────────
  if (secret && req.headers.get("x-webhook-secret") !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!supabaseUrl || !supabaseKey || !resendKey) {
    return res.status(500).json({ error: "Missing required env vars" });
  }

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
  };

  const { run_id: requestedRunId, limit: rawLimit, test } = req.body ?? {};
  const limit = Math.min(Number(rawLimit) || 50, 100);

  // ── Resolve run: requested run_id or the most recent processed run ────────
  let runId = requestedRunId;
  let runRow = null;

  if (runId) {
    const { ok, json } = await apiGet(
      `${supabaseUrl}/rest/v1/lead_feed_runs?id=eq.${runId}&select=*&limit=1`,
      headers
    );
    if (!ok || !Array.isArray(json) || !json[0]) {
      return res.status(404).json({ error: `Run ${runId} not found` });
    }
    runRow = json[0];
  } else {
    // Find most recent processed run for the tantapulse_sample funnel
    const { ok, json } = await apiGet(
      `${supabaseUrl}/rest/v1/lead_feed_runs?select=*&status=eq.processed&order=processed_at.desc&limit=1`,
      headers
    );
    if (!ok || !Array.isArray(json) || !json[0]) {
      return res.status(404).json({ error: "No processed runs found" });
    }
    runRow = json[0];
    runId  = runRow.id;
  }

  if (runRow.status !== "processed") {
    return res.status(400).json({ error: `Run ${runId} is not yet processed (status: ${runRow.status})` });
  }

  // ── Fetch scored leads ────────────────────────────────────────────────────
  const { ok, json: leads, status } = await apiGet(
    `${supabaseUrl}/rest/v1/lead_feed_leads?select=business_name,niche,city,phone,website,lead_score,score_band,source&run_id=eq.${runId}&order=lead_score.desc&limit=${limit}`,
    headers
  );

  if (!ok) {
    return res.status(500).json({ error: "Failed to fetch leads", detail: status });
  }

  const leadList = Array.isArray(leads) ? leads : [];

  // ── Determine recipient ────────────────────────────────────────────────────
  let toEmail = runRow.request_email;
  let toName  = runRow.request_name;

  if (test === "true" || test === true) {
    toEmail = "hello@tantapulse.com";
    toName  = "QA Preview";
  }

  if (!toEmail) {
    return res.status(400).json({ error: "No request_email found for this run" });
  }

  // ── Render & send ─────────────────────────────────────────────────────────
  const html = renderHtml({ name: toName, leads: leadList, runId });

  const emailRes = await fetch("https://api.resend.com/emails", {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resendKey}`,
    },
    body: JSON.stringify({
      from:    "Tanta Pulse <noreply@tantaholdings.com>",
      to:      toEmail,
      reply_to: "hello@tantapulse.com",
      subject: STEP_COPY.subject,
      html,
      headers: {
        "List-Unsubscribe":       "<mailto:hello@tantapulse.com?subject=unsubscribe>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });

  const emailText = await emailRes.text();
  let emailJson;
  try { emailJson = JSON.parse(emailText); } catch { emailJson = {}; }

  if (!emailRes.ok) {
    console.error("[Tanta Pulse] deliver-sample send failed:", emailRes.status, emailText);
    return res.status(500).json({
      error:   "Delivery failed",
      detail:  emailJson,
      run_id:  runId,
    });
  }

  // Send the monetization step only after Resend accepted the sample delivery.
  const upsellRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resendKey}`,
    },
    body: JSON.stringify({
      from: "Tanta Pulse <noreply@tantaholdings.com>",
      to: toEmail,
      reply_to: "hello@tantapulse.com",
      subject: "Ready to subscribe? Choose your Tanta Pulse plan",
      html: renderUpsellHtml({ name: toName }),
      headers: {
        "List-Unsubscribe": "<mailto:hello@tantapulse.com?subject=unsubscribe>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
  const upsellText = await upsellRes.text();
  let upsellJson = {};
  try { upsellJson = JSON.parse(upsellText); } catch { /* noop */ }
  if (!upsellRes.ok) {
    console.error("[Tanta Pulse] sample upsell send failed:", upsellRes.status, upsellText);
  }

  // ── Mark run sample_delivered (unless test mode) ──────────────────────────
  if (!(test === "true" || test === true)) {
    await apiPatch(
      `${supabaseUrl}/rest/v1/lead_feed_runs?id=eq.${runId}`,
      { status: "sample_delivered" },
      headers
    );
  }

  return res.status(200).json({
    ok:          true,
    run_id:      runId,
    sent_to:     toEmail,
    lead_count:  leadList.length,
    email_id:    emailJson.id ?? null,
    upsell: {
      sent: upsellRes.ok,
      email_id: upsellJson.id ?? null,
      status: upsellRes.status,
    },
  });
}

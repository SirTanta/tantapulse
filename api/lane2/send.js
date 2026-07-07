/**
 * Lane 2 — Resend follow-up handler
 * GET|POST /api/lane2/send
 *
 * Polls lane2_followup_queue for rows where status='pending' and
 * scheduled_for <= now, then sends via Resend using the TantaPulse
 * email template structure.
 *
 * After a successful send, marks the row status='sent' and removes it
 * (or keeps it for audit depending on config).
 *
 * Env vars required:
 *   RESEND_API_KEY
 *   THOS_SUPABASE_URL, THOS_SUPABASE_SERVICE_KEY
 */

const STEP_COPY = {
  0: {
    subject: "HVAC leads in Austin — Lane 2 feed ready",
    intro:   (name) =>
      name
        ? `Hi ${name}, your Lane 2 HVAC feed for Austin TX is ready.`
        : "Your Lane 2 HVAC feed for Austin TX is ready.",
  },
  1: {
    subject: "Following up — Austin HVAC leads",
    intro:   (name) =>
      name
        ? `Hi ${name}, wanted to make sure you saw the Austin HVAC feed.`
        : "Following up on the Austin HVAC lead feed.",
  },
  2: {
    subject: "Austin HVAC leads — last chance this cycle",
    intro:   (name) =>
      name
        ? `Hi ${name}, this is the final reminder for the current Austin HVAC feed.`
        : "Final reminder: Austin HVAC lead feed closes this cycle.",
  },
};

const STEP_BODY = {
  0: "We've scored, deduplicated, and ranked HVAC companies across Austin TX. High-intent leads (score 80+) are ready for immediate outreach. All leads include phone, website, and service type.",
  1: "If you want a tighter filter — by service type, city, or minimum score — just reply and we'll adjust the next run.",
  2: "The current feed closes after today. If you want to keep the lane open as a recurring delivery, reply and we'll set up cadence.",
};

function esc(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderHtml({ step, name, email, body }) {
  const entry = STEP_COPY[step] || STEP_COPY[0];
  return `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0b1020;margin:0;padding:0">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:40px 16px">
      <table width="600" cellpadding="0" cellspacing="0"
        style="background:#101936;border:1px solid rgba(241,198,106,0.18);border-radius:16px;overflow:hidden;max-width:600px;width:100%">
        <tr>
          <td style="padding:22px 28px;background:linear-gradient(135deg,#0b1020,#101936);border-bottom:1px solid rgba(241,198,106,0.18)">
            <span style="color:#f1c66a;font-size:18px;font-weight:900;letter-spacing:0.08em">TANTA PULSE</span>
            <span style="color:rgba(255,255,255,0.45);font-size:12px;margin-left:10px;text-transform:uppercase;letter-spacing:0.18em">Lane 2 &middot; Austin HVAC</span>
          </td>
        </tr>
        <tr>
          <td style="padding:28px">
            <p style="margin:0 0 12px;color:#fff;font-size:22px;font-weight:800">${esc(entry.subject)}</p>
            <p style="margin:0 0 16px;color:rgba(255,255,255,0.78);font-size:15px;line-height:1.7">${esc(entry.intro(name))}</p>
            <p style="margin:0;color:rgba(255,255,255,0.75);font-size:15px;line-height:1.7">${esc(body)}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 28px 28px;color:rgba(255,255,255,0.48);font-size:12px;line-height:1.6">
            Tanta Holdings LLC &middot; <a href="https://tantapulse.com/unsubscribe" style="color:rgba(241,198,106,0.7)">Unsubscribe</a>
            &nbsp;&middot;&nbsp;
            <a href="mailto:hello@tantapulse.com" style="color:rgba(255,255,255,0.35)">hello@tantapulse.com</a>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Supabase helpers ───────────────────────────────────────────────────────

async function apiGet(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* noop */ }
  return { ok: res.ok, status: res.status, text, json };
}

async function apiDelete(url, headers = {}) {
  const res = await fetch(url, { method: "DELETE", headers });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
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

// ── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.THOS_SUPABASE_SERVICE_KEY;
  const resendKey   = process.env.RESEND_API_KEY;

  if (!resendKey) {
    return res.status(200).json({ ok: true, sent: 0, note: "RESEND_API_KEY not configured" });
  }
  if (!supabaseUrl || !supabaseKey) {
    return res.status(200).json({ ok: true, sent: 0, note: "Supabase not configured" });
  }

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
  };

  const now = new Date().toISOString();
  const qs = new URLSearchParams({
    select: "id,email,business_name,step,scheduled_for",
    status:  "eq.pending",
    scheduled_for: `lte.${now}`,
    order:   "scheduled_for.asc",
    limit:   "50",
  });

  const { ok, json } = await apiGet(
    `${supabaseUrl}/rest/v1/lane2_followup_queue?${qs}`,
    headers
  );

  if (!ok) {
    return res.status(200).json({ ok: true, sent: 0, note: "Queue query failed" });
  }

  const rows = Array.isArray(json) ? json : [];
  if (!rows.length) {
    return res.status(200).json({ ok: true, sent: 0, note: "No due rows" });
  }

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    const step  = Number(row.step) || 0;
    const name  = row.business_name || row.email || "there";
    const body  = STEP_BODY[step] || STEP_BODY[0];
    const entry = STEP_COPY[step] || STEP_COPY[0];

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from:    "Tanta Pulse <noreply@tantaholdings.com>",
        to:      row.email,
        subject: entry.subject,
        html:    renderHtml({ step, name, email: row.email, body }),
        headers: {
          "List-Unsubscribe": "<mailto:hello@tantapulse.com?subject=unsubscribe>",
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    });

    if (emailRes.ok) {
      // Mark as sent and remove from queue
      await apiDelete(
        `${supabaseUrl}/rest/v1/lane2_followup_queue?id=eq.${encodeURIComponent(row.id)}`,
        headers
      );
      sent += 1;
    } else {
      // Mark as failed
      await apiPatch(
        `${supabaseUrl}/rest/v1/lane2_followup_queue?id=eq.${encodeURIComponent(row.id)}`,
        { status: "failed" },
        headers
      );
      failed += 1;
      console.error(`[Lane2 Send] delivery failed for ${row.email}: ${emailRes.status}`);
    }
  }

  return res.status(200).json({ ok: true, sent, failed, total: rows.length });
}

const STEP_COPY = {
  0: {
    subject: "Your Tanta Pulse sample request is in",
    intro: (name) => `Thanks, ${name}. We got your request and the sample is being prepared.`,
  },
  1: {
    subject: "Want a tighter niche for your sample feed?",
    intro: (name) => `Quick follow-up, ${name}. If you want a narrower market, reply with the niche and city.`,
  },
  2: {
    subject: "Here’s how we rank the leads",
    intro: (name) => `A fast note, ${name}: we clean, dedupe, and score before anything goes out.`,
  },
  3: {
    subject: "Ready for a sample feed?",
    intro: (name) => `Final nudge, ${name}. If you want the feed, we can turn on a recurring delivery lane.`,
  },
};

function esc(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

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

async function apiDelete(url, headers = {}) {
  const res = await fetch(url, { method: "DELETE", headers });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

function renderHtml({ step, name, email, body }) {
  const entry = STEP_COPY[step] || STEP_COPY[0];
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0b1020;margin:0;padding:0">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#101936;border:1px solid rgba(241,198,106,0.18);border-radius:16px;overflow:hidden;max-width:600px;width:100%">
      <tr><td style="padding:22px 28px;background:linear-gradient(135deg,#0b1020,#101936);border-bottom:1px solid rgba(241,198,106,0.18)">
        <span style="color:#f1c66a;font-size:18px;font-weight:900;letter-spacing:0.08em">TANTA PULSE</span>
        <span style="color:rgba(255,255,255,0.45);font-size:12px;margin-left:10px;text-transform:uppercase;letter-spacing:0.18em">Follow-up ${step}</span>
      </td></tr>
      <tr><td style="padding:28px">
        <p style="margin:0 0 12px;color:#fff;font-size:22px;font-weight:800">${esc(entry.subject)}</p>
        <p style="margin:0 0 16px;color:rgba(255,255,255,0.78);font-size:15px;line-height:1.7">${esc(entry.intro(name))}</p>
        <p style="margin:0;color:rgba(255,255,255,0.75);font-size:15px;line-height:1.7">${body}</p>
      </td></tr>
      <tr><td style="padding:16px 28px 28px;color:rgba(255,255,255,0.48);font-size:12px;line-height:1.6">
        Tanta Holdings LLC &middot; <a href="https://tantapulse.com/unsubscribe" style="color:rgba(241,198,106,0.7)">Unsubscribe</a> &middot; <a href="mailto:hello@tantapulse.com" style="color:rgba(255,255,255,0.35)">hello@tantapulse.com</a>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.THOS_SUPABASE_SERVICE_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  if (!supabaseUrl || !supabaseKey || !resendKey) {
    return res.status(200).json({ ok: true, sent: 0, note: "Missing env vars" });
  }

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
  };
  const now = new Date().toISOString();
  const query = new URLSearchParams({
    select: "id,email,name,funnel,step,scheduled_for",
    funnel: "eq.tantapulse_sample",
    scheduled_for: `lte.${now}`,
    order: "scheduled_for.asc",
    limit: "50",
  });
  const { ok, json } = await apiGet(`${supabaseUrl}/rest/v1/email_sequence?${query.toString()}`, headers);
  if (!ok) {
    return res.status(200).json({ ok: true, sent: 0, note: "No due rows or query failed" });
  }

  const rows = Array.isArray(json) ? json : [];
  let sent = 0;
  for (const row of rows) {
    const step = Number(row.step) || 0;
    const name = row.name || row.email || "there";
    const entry = STEP_COPY[step] || STEP_COPY[0];
    const body = step === 0
      ? "We’ve queued your sample and will keep the follow-up short. If you want a tighter niche, just reply with the market name."
      : step === 1
        ? "If you want us to narrow the sample by service type or city size, reply with the details and we’ll adjust."
        : step === 2
          ? "The ranking step is what makes the feed usable. If you want, we can add or remove filters before the next send."
          : "If you want to turn the sample into a recurring feed, reply and we’ll keep the lane open.";

    const emailRes = await apiSend("https://api.resend.com/emails", {
      from: "Tanta Pulse <noreply@tantaholdings.com>",
      to: row.email,
      reply_to: "hello@tantapulse.com",
      subject: entry.subject,
      html: renderHtml({ step, name, email: row.email, body }),
      headers: {
        "List-Unsubscribe": "<mailto:hello@tantapulse.com?subject=unsubscribe>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }, { Authorization: `Bearer ${resendKey}` });

    if (emailRes.ok) {
      await apiDelete(`${supabaseUrl}/rest/v1/email_sequence?id=eq.${encodeURIComponent(row.id)}`, headers);
      sent += 1;
    } else {
      console.error("[Tanta Pulse] follow-up send failed:", emailRes.status, emailRes.text);
    }
  }

  return res.status(200).json({ ok: true, sent });
}

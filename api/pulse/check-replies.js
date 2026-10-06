/**
 * GET|POST /api/pulse/check-replies
 *
 * Reply detection for the TantaPulse cold-outreach loop. Polls hello@tantapulse.com
 * via the Zoho Mail API using a READ-scoped OAuth token (same credential and token
 * exchange already used read-only by /home/mulagent/classifiers/social_outreach_reality.py
 * on thos-hermes), finds inbound messages whose sender address matches a row in
 * pulse_outreach_sends, and sets pulse_outreach_sends.replied_at the first time a
 * reply is seen. Closes the funnel: sent -> delivered -> opened/clicked -> replied
 * -> sample requested -> paid.
 *
 * Auth: Authorization: Bearer $CRON_SECRET (Vercel cron sends this). Fails closed.
 *
 * Keys required (Infisical -> Vercel env):
 *   TANTAPULSE_ZOHO_OAUTH_CLIENT_ID
 *   TANTAPULSE_ZOHO_OAUTH_CLIENT_SECRET
 *   TANTAPULSE_ZOHO_OAUTH_REFRESH_TOKEN_READONLY  (mail.READ scope only; the
 *     handler refuses to run if the token it gets back carries any non-.READ scope)
 */
import { recordHeartbeat } from "../../lib/pulse-heartbeat.mjs";

const INBOX_WINDOW_DAYS = 14;
const SYSTEM_SENDER =
  /mailer-daemon|postmaster|no-?reply|notifications?@|updates@|@zohocorp\.com|@zoho\.com/i;

function db() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.THOS_SUPABASE_SERVICE_KEY;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  return {
    ok: Boolean(url && key),
    get: async (path) => {
      const res = await fetch(`${url}/rest/v1/${path}`, { headers });
      if (!res.ok)
        throw new Error(`db GET ${path} ${res.status}: ${await res.text()}`);
      return res.json();
    },
    patch: async (path, body) => {
      const res = await fetch(`${url}/rest/v1/${path}`, {
        method: "PATCH",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify(body),
      });
      if (!res.ok)
        throw new Error(`db PATCH ${path} ${res.status}: ${await res.text()}`);
    },
  };
}

async function zohoAccessToken() {
  const params = new URLSearchParams({
    refresh_token: process.env.TANTAPULSE_ZOHO_OAUTH_REFRESH_TOKEN_READONLY,
    client_id: process.env.TANTAPULSE_ZOHO_OAUTH_CLIENT_ID,
    client_secret: process.env.TANTAPULSE_ZOHO_OAUTH_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(
      `zoho token exchange failed: ${res.status} ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  const scopes = String(json.scope || "")
    .split(" ")
    .filter(Boolean);
  if (!scopes.length || scopes.some((s) => !s.endsWith(".READ"))) {
    throw new Error(
      `refusing to use a non-read-only Zoho token (scopes: ${scopes.join(",")})`,
    );
  }
  return json.access_token;
}

async function zohoGet(path, token) {
  const res = await fetch(`https://mail.zoho.com/api${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      `zoho mail api ${path} ${res.status}: ${JSON.stringify(json).slice(0, 200)}`,
    );
  return json;
}

async function listInbox(token, cutoffMs) {
  const { data: accounts } = await zohoGet("/accounts", token);
  const accountId = accounts[0].accountId;
  const { data: folders } = await zohoGet(
    `/accounts/${accountId}/folders`,
    token,
  );
  const inboxFolder = folders.find((f) => f.folderName === "Inbox");
  if (!inboxFolder) throw new Error("Inbox folder not found");

  const rows = [];
  for (let page = 0; page < 10; page++) {
    const { data = [] } = await zohoGet(
      `/accounts/${accountId}/messages/view?folderId=${inboxFolder.folderId}&limit=200&start=${1 + 200 * page}&sortorder=false`,
      token,
    );
    rows.push(...data);
    const last = data[data.length - 1];
    if (data.length < 200 || !last || Number(last.receivedTime) < cutoffMs)
      break;
  }
  return rows;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const d = db();
  if (
    !d.ok ||
    !process.env.TANTAPULSE_ZOHO_OAUTH_REFRESH_TOKEN_READONLY ||
    !process.env.TANTAPULSE_ZOHO_OAUTH_CLIENT_ID ||
    !process.env.TANTAPULSE_ZOHO_OAUTH_CLIENT_SECRET
  ) {
    await recordHeartbeat("pulse_check_replies", false, { reason: "missing_configuration" });
    return res.status(500).json({ error: "Missing configuration" });
  }

  try {
    const cutoff = Date.now() - INBOX_WINDOW_DAYS * 86400000;
    const token = await zohoAccessToken();
    const inbox = await listInbox(token, cutoff);

    const pending = await d.get(
      "pulse_outreach_sends?replied_at=is.null&select=id,email,sent_at",
    );
    const byEmail = new Map();
    for (const row of pending) {
      const key = row.email.toLowerCase();
      if (!byEmail.has(key)) byEmail.set(key, []);
      byEmail.get(key).push(row);
    }

    let matched = 0;
    const touched = [];
    for (const msg of inbox) {
      const from = (msg.fromAddress || "")
        .toLowerCase()
        .match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0];
      if (!from || SYSTEM_SENDER.test(from)) continue;
      const candidates = byEmail.get(from);
      if (!candidates) continue;
      const receivedAt = new Date(Number(msg.receivedTime));
      for (const row of candidates) {
        if (receivedAt <= new Date(row.sent_at)) continue; // reply must postdate our send
        await d.patch(`pulse_outreach_sends?id=eq.${row.id}`, {
          replied_at: receivedAt.toISOString(),
        });
        matched++;
        touched.push({ email: from, replied_at: receivedAt.toISOString() });
        row.replied_at = receivedAt.toISOString(); // don't rematch within this pass
      }
    }

    await recordHeartbeat("pulse_check_replies", true, {
      inbox_messages_scanned: inbox.length,
      pending_sends_checked: pending.length,
      replies_matched: matched,
    });
    return res.status(200).json({
      ok: true,
      inbox_messages_scanned: inbox.length,
      pending_sends_checked: pending.length,
      replies_matched: matched,
      touched,
    });
  } catch (err) {
    console.error(`[check-replies] ${err.message}`);
    await recordHeartbeat("pulse_check_replies", false, { error: err.message });
    return res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/pulse/webhook
 *
 * Resend webhook receiver for TantaPulse email delivery events.
 * Logs email.sent / email.delivered / email.delivery_delayed / email.opened /
 * email.clicked / email.bounced / email.complained into pulse_email_events,
 * keyed to pulse_outreach_sends.resend_id (and any other TantaPulse send:
 * market-check, paid feed, onboarding).
 *
 * Signature verification: Resend signs webhook bodies with Svix
 * (https://docs.svix.com/receiving/verifying-payloads/how-manual).
 * Secret comes from RESEND_WEBHOOK_SECRET (format "whsec_...", returned once
 * at webhook-creation time and stored in Infisical -> Vercel env).
 */
import { createHmac, timingSafeEqual } from "crypto";

// Vercel: disable JSON body parsing so we get the exact raw bytes Resend signed.
export const config = {
  api: {
    bodyParser: false,
  },
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function verifySvixSignature(rawBody, headers, secret) {
  const id = headers["svix-id"];
  const timestamp = headers["svix-timestamp"];
  const sigHeader = headers["svix-signature"];
  if (!id || !timestamp || !sigHeader || !secret) return false;

  // Reject stale/replayed deliveries (5 minute tolerance).
  const tsSeconds = Number(timestamp);
  if (
    !Number.isFinite(tsSeconds) ||
    Math.abs(Date.now() / 1000 - tsSeconds) > 300
  ) {
    return false;
  }

  const secretBytes = Buffer.from(secret.split("_")[1] || "", "base64");
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", secretBytes)
    .update(signedContent)
    .digest("base64");
  const expectedBuf = Buffer.from(expected);

  return sigHeader
    .split(" ")
    .map((entry) => entry.split(",")[1])
    .filter(Boolean)
    .some((candidate) => {
      const candBuf = Buffer.from(candidate);
      return (
        candBuf.length === expectedBuf.length &&
        timingSafeEqual(candBuf, expectedBuf)
      );
    });
}

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
    insert: async (path, body) => {
      const res = await fetch(`${url}/rest/v1/${path}`, {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "return=minimal,resolution=ignore-duplicates",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok && res.status !== 409) {
        const text = await res.text();
        throw new Error(
          `db insert ${path} ${res.status}: ${text.slice(0, 300)}`,
        );
      }
    },
  };
}

const KNOWN_EVENTS = new Set([
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.complained",
]);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[pulse webhook] RESEND_WEBHOOK_SECRET not set");
    return res.status(500).json({ error: "Webhook not configured." });
  }

  const rawBody = await readRawBody(req);
  if (!verifySvixSignature(rawBody, req.headers, secret)) {
    console.warn("[pulse webhook] signature verification failed");
    return res.status(400).json({ error: "Invalid signature." });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid JSON body." });
  }

  const type = event.type;
  if (!KNOWN_EVENTS.has(type)) {
    // Ack anything we're not subscribed to processing (e.g. email.received,
    // email.failed, email.scheduled, email.suppressed) instead of 400ing it.
    return res.status(200).json({ ok: true, ignored: type || "unknown" });
  }

  const data = event.data || {};
  const resendId = data.email_id || data.id;
  if (!resendId) {
    return res.status(200).json({ ok: true, ignored: "no email_id" });
  }

  const d = db();
  if (!d.ok) {
    return res.status(500).json({ error: "Missing configuration" });
  }

  try {
    await d.insert("pulse_email_events", {
      resend_id: resendId,
      event_type: type,
      occurred_at:
        data.created_at || event.created_at || new Date().toISOString(),
      recipient: Array.isArray(data.to) ? data.to[0] : data.to || null,
      link_url: data.click?.link || null,
      payload: event,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`[pulse webhook] ${err.message}`);
    // Resend retries on non-2xx; a transient DB error should be retried.
    return res.status(500).json({ error: err.message });
  }
}

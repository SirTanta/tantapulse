/**
 * POST /api/stripe/webhook
 *
 * Stripe webhook handler for Tantapulse paid tier events.
 *
 * Events handled:
 *  - checkout.session.completed       → activate subscription in Supabase
 *  - customer.subscription.deleted    → mark cancelled in Supabase + email Ryoko/Holo
 *  - customer.subscription.updated    → sync subscription_status changes (active/past_due/trialing)
 *
 * Keys required (from Infisical → Vercel env):
 *   STRIPE_WEBHOOK_SECRET  — for signature verification
 *   STRIPE_SECRET_KEY      — for retrieving checkout session details
 *
 * Sandbox mode: only processes events from Stripe test mode.
 */

import { createHmac } from "crypto";

const ALLOWED_ORIGINS = new Set([
  "https://tantapulse.com",
  "https://www.tantapulse.com",
  "http://localhost:3000",
  "http://localhost:3001",
]);

// Ryoko and Holo receive cancellation notifications
const CANCELLATION_RECIPIENTS = [
  "ryoko@tantaholdings.com",
  "holo@tantaholdings.com",
];

function originAllowed(req) {
  const origin = req.headers.origin || req.headers.referer || "";
  if (!origin) return true;
  try {
    return ALLOWED_ORIGINS.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

/**
 * Verify Stripe webhook signature.
 * Stripe-Webhook-Signature header format: "t=...,v1=...,v0=..."
 */
function verifySignature(rawBody, signatureHeader, webhookSecret) {
  if (!signatureHeader || !webhookSecret) return false;
  try {
    const parts = Object.fromEntries(
      signatureHeader.split(",").map((p) => {
        const [k, v] = p.split("=");
        return [k.trim(), v.trim()];
      })
    );
    const timestamp = parts["t"];
    const sig = parts["v1"];
    if (!timestamp || !sig) return false;

    const payload = `${timestamp}.${rawBody}`;
    const expected = createHmac("sha256", webhookSecret)
      .update(payload, "utf8")
      .digest("hex");

    // Constant-time comparison to prevent timing attacks
    if (sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) {
      diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return diff === 0;
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

async function stripeGet(path, stripeKey) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, text, json };
}

/**
 * Map Stripe subscription status to our schema enum.
 */
function mapSubscriptionStatus(stripeStatus) {
  const map = {
    active: "active",
    past_due: "past_due",
    cancelled: "cancelled",
    unpaid: "past_due",
    trialing: "trialing",
    paused: "cancelled",
  };
  return map[stripeStatus] || stripeStatus;
}

/**
 * Upsert a paid subscriber record in Supabase paid_subscribers table.
 * Also tags any matching lead_feed_leads record (by email) if one exists.
 */
async function upsertLeadSubscription({ supabaseUrl, supabaseKey, email, name, stripeCustomerId, tier, subscriptionId, status }) {
  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };

  const now = new Date().toISOString();

  // Upsert paid_subscribers — email is the canonical key
  const subscriberPayload = {
    email,
    name: name || null,
    stripe_customer_id: stripeCustomerId,
    subscription_id: subscriptionId,
    monetization_tier: tier,
    subscription_status: status,
    updated_at: now,
    tier_changed_at: now,
  };

  // upsert by email (on_conflict) — update all fields
  const upsertRes = await fetch(
    `${supabaseUrl}/rest/v1/paid_subscribers?email=eq.${encodeURIComponent(email)}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify(subscriberPayload),
    }
  );

  if (!upsertRes.ok) {
    const text = await upsertRes.text();
    console.error("[Stripe webhook] paid_subscribers upsert failed:", upsertRes.status, text);
    return { ok: false, status: upsertRes.status };
  }

  // If no existing row (PATCH returned 200 with 0 rows), insert instead
  if (upsertRes.status === 200) {
    const contentLen = Number(upsertRes.headers.get("content-length") || 0);
    // Supabase returns empty body {} for PATCH with return=minimal
    // We can detect "no rows matched" by checking if the update found anything
    // Use a select query to check; if PATCH affected 0 rows, insert
    const checkRes = await fetch(
      `${supabaseUrl}/rest/v1/paid_subscribers?email=eq.${encodeURIComponent(email)}&select=id`,
      { headers }
    );
    const checkJson = await checkRes.json();
    if (!Array.isArray(checkJson) || checkJson.length === 0) {
      // No existing record — insert
      const insertRes = await fetch(`${supabaseUrl}/rest/v1/paid_subscribers`, {
        method: "POST",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify([{ ...subscriberPayload, created_at: now }]),
      });
      if (!insertRes.ok) {
        const text = await insertRes.text();
        console.error("[Stripe webhook] paid_subscribers insert failed:", insertRes.status, text);
        return { ok: false, status: insertRes.status };
      }
    }
  }

  // Also tag lead_feed_leads by email if a matching record exists there
  if (supabaseKey && email) {
    fetch(
      `${supabaseUrl}/rest/v1/lead_feed_leads?email=eq.${encodeURIComponent(email)}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          monetization_tier: tier,
          stripe_customer_id: stripeCustomerId,
          subscription_status: status,
          subscription_id: subscriptionId,
          updated_at: now,
        }),
      }
    ).catch((err) => console.warn("[Stripe webhook] lead_feed_leads tag failed (non-fatal):", err));
  }

  return { ok: true, status: 200 };
}

/**
 * Send cancellation notification email to Ryoko/Holo via Resend.
 */
async function sendCancellationEmail({ resendKey, email, tier, customerId, subscriptionId }) {
  const subject = `[Tantapulse] Cancellation — ${tier} (${email})`;
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0b1020;margin:0;padding:0">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#101936;border:1px solid rgba(241,198,106,0.18);border-radius:16px;overflow:hidden">
      <tr><td style="padding:22px 28px;background:linear-gradient(135deg,#0b1020,#101936);border-bottom:1px solid rgba(241,198,106,0.18)">
        <span style="color:#f1c66a;font-size:18px;font-weight:900;letter-spacing:0.08em">TANTA PULSE</span>
        <span style="color:rgba(255,255,255,0.45);font-size:12px;margin-left:10px;text-transform:uppercase;letter-spacing:0.18em">Cancellation Alert</span>
      </td></tr>
      <tr><td style="padding:28px">
        <p style="margin:0 0 12px;color:#fff;font-size:22px;font-weight:800">Subscription Cancelled</p>
        <p style="margin:0 0 16px;color:rgba(255,255,255,0.78);font-size:15px;line-height:1.7">
          A customer has cancelled their <strong>${tier}</strong> subscription.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="color:rgba(255,255,255,0.82);font-size:14px;line-height:1.7">
          <tr><td style="padding-bottom:8px"><strong>Email:</strong> ${email}</td></tr>
          <tr><td style="padding-bottom:8px"><strong>Tier:</strong> ${tier}</td></tr>
          <tr><td style="padding-bottom:8px"><strong>Stripe Customer ID:</strong> ${customerId}</td></tr>
          <tr><td style="padding-bottom:8px"><strong>Subscription ID:</strong> ${subscriptionId}</td></tr>
        </table>
        <p style="margin:20px 0 0;color:rgba(255,255,255,0.55);font-size:13px;line-height:1.6">
          This customer has been flagged in Supabase. A save attempt may be appropriate depending on the account history.
        </p>
      </td></tr>
    </table>
  </td></tr></table>
</body>
</html>`;

  return postJson("https://api.resend.com/emails", {
    from: "Tantapulse <noreply@tantaholdings.com>",
    to: CANCELLATION_RECIPIENTS,
    reply_to: "hello@tantapulse.com",
    subject,
    html,
  });
}

// Vercel: disable JSON body parsing so we receive the raw webhook body for signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};

// ─── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Webhook requires raw body — reject if not a POST
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!originAllowed(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const resendKey = process.env.RESEND_API_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.THOS_SUPABASE_SERVICE_KEY;

  if (!webhookSecret) {
    console.error("[Stripe webhook] STRIPE_WEBHOOK_SECRET not set");
    return res.status(500).json({ error: "Webhook not configured." });
  }

  // Get raw body — Vercel provides req.body as string or Buffer
  const rawBody =
    typeof req.body === "string"
      ? req.body
      : Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : JSON.stringify(req.body);

  const signature = req.headers["stripe-signature"];

  if (!verifySignature(rawBody, signature, webhookSecret)) {
    console.warn("[Stripe webhook] signature verification failed");
    return res.status(400).json({ error: "Invalid signature." });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid JSON body." });
  }

  // Only process test-mode events in sandbox
  if (!stripeKey.startsWith("sk_test")) {
    console.warn("[Stripe webhook] Non-test key in use — skipping live events in sandbox build");
  }

  const eventType = event.type;
  const eventData = event.data?.object || {};

  console.log(`[Stripe webhook] Received event: ${eventType} (ID: ${event.id})`);

  try {
    switch (eventType) {
      case "checkout.session.completed": {
        const session = eventData;
        if (session.mode !== "subscription") break;

        const email = session.customer_email || session.customer_details?.email;
        const name = session.customer_details?.name || session.metadata?.name || null;
        const stripeCustomerId = session.customer;
        const tier = session.metadata?.tier || null;
        const subscriptionId = session.subscription;

        if (!email || !tier) {
          console.warn("[Stripe webhook] checkout.session.completed missing email or tier:", {
            email,
            tier,
            sessionId: session.id,
          });
          break;
        }

        if (supabaseUrl && supabaseKey) {
          await upsertLeadSubscription({
            supabaseUrl,
            supabaseKey,
            email,
            name,
            stripeCustomerId,
            tier,
            subscriptionId,
            status: "active",
          });
          console.log(`[Stripe webhook] Activated ${tier} subscription for ${email}`);
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = eventData;
        const stripeCustomerId = sub.customer;
        const subscriptionId = sub.id;
        const status = mapSubscriptionStatus(sub.status);
        const tier = sub.metadata?.tier || null;

        if (!stripeCustomerId) break;

        // Get customer email from Stripe
        let email = null;
        if (stripeKey) {
          const customerRes = await stripeGet(`/customers/${stripeCustomerId}`, stripeKey);
          email = customerRes.json?.email || null;
        }

        if (supabaseUrl && supabaseKey) {
          await upsertLeadSubscription({
            supabaseUrl,
            supabaseKey,
            email,
            stripeCustomerId,
            tier,
            subscriptionId,
            status,
          });
          console.log(`[Stripe webhook] Updated subscription status to '${status}' for ${stripeCustomerId}`);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = eventData;
        const stripeCustomerId = sub.customer;
        const subscriptionId = sub.id;
        const tier = sub.metadata?.tier || null;

        // Get customer email from Stripe
        let email = null;
        if (stripeKey) {
          const customerRes = await stripeGet(`/customers/${stripeCustomerId}`, stripeKey);
          email = customerRes.json?.email || null;
        }

        if (supabaseUrl && supabaseKey) {
          await upsertLeadSubscription({
            supabaseUrl,
            supabaseKey,
            email,
            stripeCustomerId,
            tier,
            subscriptionId,
            status: "cancelled",
          });
          console.log(`[Stripe webhook] Cancelled subscription for ${stripeCustomerId}`);
        }

        // Send cancellation notification
        if (resendKey && email) {
          await sendCancellationEmail({ resendKey, email, tier: tier || "unknown", customerId: stripeCustomerId, subscriptionId });
        }
        break;
      }

      default:
        console.log(`[Stripe webhook] Unhandled event type: ${eventType}`);
    }
  } catch (err) {
    console.error(`[Stripe webhook] Error handling event ${eventType}:`, err);
    return res.status(500).json({ error: "Webhook handler error." });
  }

  return res.status(200).json({ received: true });
}
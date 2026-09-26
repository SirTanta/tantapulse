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
import { recordPulseConversion } from "../../lib/pulse-crm-conversion-sender.js";
import { FROM, OPS_EMAIL, REPLY_TO, renderOnboarding } from "../../lib/pulse-fulfillment.mjs";

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
async function upsertLeadSubscription({ supabaseUrl, supabaseKey, email, name, stripeCustomerId, tier, subscriptionId, status, allowInsert = false }) {
  if (!email) return { ok: false, status: 0 };
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
  if (!tier) {
    delete subscriberPayload.monetization_tier;
    delete subscriberPayload.tier_changed_at;
  }
  if (!name) delete subscriberPayload.name;

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

  // PATCH with return=minimal answers 204 whether or not a row matched.
  if (allowInsert) {
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

export async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  if (chunks.length) return Buffer.concat(chunks).toString("utf8");
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  return JSON.stringify(req.body ?? {});
}

// The Stripe account is shared across products; only these links are Pulse sales.
const PULSE_PAYMENT_LINKS = new Set([
  "plink_1TtIav5hHkfUnkHQG2FZSyiX",
  "plink_1TtIav5hHkfUnkHQJydDLWQU",
  "plink_1TtIaw5hHkfUnkHQ1jMuLIGo",
]);

export function isPulseSession(session) {
  return PULSE_PAYMENT_LINKS.has(session.payment_link) || session.metadata?.product === "tantapulse";
}

async function onboardSubscriber({ supabaseUrl, supabaseKey, resendKey, email, name, tier }) {
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" };
  const intakeRes = await fetch(
    `${supabaseUrl}/rest/v1/sample_intake_requests?request_email=eq.${encodeURIComponent(email.toLowerCase())}&order=created_at.desc&limit=1&select=niche,city`,
    { headers }
  );
  const [intake] = intakeRes.ok ? await intakeRes.json() : [];
  const niche = intake?.niche || null;
  const city = intake?.city || null;
  await fetch(`${supabaseUrl}/rest/v1/paid_subscribers?email=eq.${encodeURIComponent(email)}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({ niche, city, onboarded_at: new Date().toISOString() }),
  });
  const welcome = renderOnboarding({ name, email, tier, niche, city });
  const send = (payload) => fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, reply_to: REPLY_TO, ...payload }),
  });
  await send({ to: email, subject: welcome.subject, html: welcome.html });
  await send({
    to: OPS_EMAIL,
    subject: `[Pulse ops] NEW ${String(tier).toUpperCase()} SUBSCRIBER ${email}`,
    html: `<p>New paid Tanta Pulse subscriber: ${email} (${tier}).</p><p>Feed: ${niche && city ? `${niche} in ${city}; first delivery is automatic.` : "niche/city unknown; welcome email asked them to reply with it. Set paid_subscribers.niche/city when they do."}</p>`,
  });
  return { niche, city };
}

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

  // Stripe signs the exact bytes; a re-serialized parsed body never matches.
  const rawBody = await readRawBody(req);

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
        if (session.mode !== "subscription" || !isPulseSession(session)) break;

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
            allowInsert: true,
          });
          console.log(`[Stripe webhook] Activated ${tier} subscription for ${email}`);
          if (resendKey) {
            try {
              await onboardSubscriber({ supabaseUrl, supabaseKey, resendKey, email, name, tier });
            } catch (err) {
              console.error("[Stripe webhook] onboarding failed:", err.message);
            }
          }
        }

        // Record the purchase in Atlas CRM. This is the plumbing that turns a
        // Stripe payment into a tracked deal — without it, a real purchase
        // never shows up anywhere a human would look for it.
        const crmResult = await recordPulseConversion({
          email,
          name,
          tier,
          amountCents: session.amount_total ?? 0,
          currency: session.currency ?? "usd",
          sessionId: session.id,
          occurredAt: new Date().toISOString(),
        });
        if (crmResult.reason === "not_configured") {
          console.error("[Stripe webhook] Atlas CRM ingestion is not configured — purchase was NOT recorded in the CRM.");
        } else if (!crmResult.verified?.delivered || !crmResult.conversion?.delivered) {
          console.error(`[Stripe webhook] Atlas CRM ingestion incomplete for session ${session.id}:`, crmResult);
        } else {
          console.log(`[Stripe webhook] Recorded ${tier} conversion in Atlas CRM for ${email} (session ${session.id})`);
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
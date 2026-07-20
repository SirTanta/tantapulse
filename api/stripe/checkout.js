/**
 * POST /api/stripe/checkout
 *
 * Creates a Stripe Checkout session for the one authorized Tantapulse purchase target.
 * Starter Checkout always uses the canonical live Stripe Price ID below.
 * STRIPE_SECRET_KEY is loaded from Vercel environment configuration.
 *
 * Body: { tier: 'starter', email: string, name?: string }
 */

const ALLOWED_ORIGINS = new Set([
  "https://tantapulse.com",
  "https://www.tantapulse.com",
  "http://localhost:3000",
  "http://localhost:3001",
]);

const STARTER_TIER = "starter";
// Canonical $49/month recurring Stripe Price. Do not replace with an inline amount.
const STARTER_PRICE_ID = "price_1TtGYS5hHkfUnkHQjhNtiobD";

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
  const contentType = headers["Content-Type"] || "application/json";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": contentType, ...headers },
    body: contentType.includes("application/json") ? JSON.stringify(body) : body,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, text, json: parsed };
}

export default async function handler(req, res) {
  if (!originAllowed(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ error: "Invalid JSON body." });
  }

  const { tier, email, name } = body;
  // Only the approved Starter target may reach payment configuration or Stripe.
  if (tier !== STARTER_TIER) {
    return res.status(400).json({ error: "Invalid purchase target." });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Valid email is required." });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error("[Stripe checkout] STRIPE_SECRET_KEY not set");
    return res.status(500).json({ error: "Payment service not configured." });
  }

  // Always use the canonical recurring Starter Price; inline amounts are prohibited.
  const lineItem = { price: STARTER_PRICE_ID, quantity: 1 };

  const sessionPayload = {
    mode: "subscription",
    customer_email: email,
    line_items: [lineItem],
    // Stripe automatically sends receipt emails; configure in Stripe dashboard
    allow_promotion_codes: true,
    billing_address_collection: "auto",
    // Sandbox mode: redirect to pricing page on cancel
    success_url: `${getBaseUrl(req)}/pricing?checkout=success&tier=${tier}`,
    cancel_url: `${getBaseUrl(req)}/pricing?checkout=cancelled`,
    metadata: {
      tier,
      email,
      name: name || "",
      source: "tantapulse_checkout",
    },
  };

  const { ok, status, json, text } = await postJson(
    "https://api.stripe.com/v1/checkout/sessions",
    new URLSearchParams(
      Object.entries(flattenSessionPayload(sessionPayload))
    ).toString(),
    {
      Authorization: `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    }
  );

  if (!ok) {
    console.error("[Stripe checkout] session creation failed:", status, text);
    return res.status(502).json({ error: "Failed to create checkout session." });
  }

  return res.status(200).json({
    ok: true,
    sessionId: json.id,
    url: json.url,
  });
}

function getBaseUrl(req) {
  const origin = req.headers.origin || req.headers.referer || "";
  if (origin) {
    try {
      return new URL(origin).origin;
    } catch {}
  }
  return "https://tantapulse.com";
}

/**
 * Flatten nested objects/arrays into a Stripe-compatible form body.
 * e.g. { line_items: [{ price: "price_..." }] } → { "line_items[0][price]": "price_...", ... }
 */
function flattenSessionPayload(obj, prefix = "") {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const fieldName = prefix ? `${prefix}[${key}]` : key;
    if (value === null || value === undefined) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flattenSessionPayload(value, fieldName));
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === "object" && item !== null) {
          Object.assign(result, flattenSessionPayload(item, `${fieldName}[${i}]`));
        } else {
          result[`${fieldName}[${i}]`] = item;
        }
      });
    } else {
      result[fieldName] = value;
    }
  }
  return result;
}
# Tantapulse Stripe Integration — G2 + G6

## What was built

| File | Purpose |
|------|---------|
| `api/stripe/checkout.js` | POST `/api/stripe/checkout` — creates a Stripe Checkout session only for the canonical Starter ($49/mo) Stripe Price; all other targets fail closed |
| `api/stripe/webhook.js` | POST `/api/stripe/webhook` — verifies Stripe webhook, updates Supabase, sends cancellation emails |
| `supabase/stripe-monetization-schema.sql` | Schema migration: adds `monetization_tier`, `stripe_customer_id`, `subscription_status`, `subscription_id` to `lead_feed_leads` |

## Prerequisites before going live

1. **G1 pricing page** must exist with correct tier names (Starter $49/mo, Growth $247/mo) before checkout is wired to production.

2. **Stripe sandbox keys** in Infisical (route to Vercel env):
   - `STRIPE_SECRET_KEY` — test mode key (`sk_test_...`)
   - `STRIPE_WEBHOOK_SECRET` — webhook signing secret (`whsec_...`)

3. **Apply schema migration** in Supabase SQL editor:
   ```sql
   \i supabase/stripe-monetization-schema.sql
   ```
   Or paste the contents of `supabase/stripe-monetization-schema.sql` directly.

4. **Register webhook endpoint** in Stripe Dashboard:
   - URL: `https://tantapulse.com/api/stripe/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the webhook signing secret back to Infisical as `STRIPE_WEBHOOK_SECRET`

5. **Do NOT activate live keys** until Shiori/Noa domain review + Motoko QA is complete.

## API shape

### POST /api/stripe/checkout
```json
// Request
{ "tier": "starter", "email": "buyer@example.com", "name": "Jane" }

// Response 200
{ "ok": true, "sessionId": "cs_...", "url": "https://checkout.stripe.com/..." }
```

### POST /api/stripe/webhook
- Verifies `Stripe-Signature` header (HMAC-SHA256)
- `checkout.session.completed` → sets `monetization_tier`, `stripe_customer_id`, `subscription_status=active` in `lead_feed_leads`
- `customer.subscription.updated` → syncs `subscription_status`
- `customer.subscription.deleted` → sets `subscription_status=cancelled`, emails Ryoko + Holo via Resend

## Sandbox testing checklist

- [ ] Schema migration applied to Supabase
- [ ] `STRIPE_SECRET_KEY=sk_test_...` set in Vercel env (from Infisical)
- [ ] `STRIPE_WEBHOOK_SECRET=whsec_...` set in Vercel env (from Infisical)
- [ ] Webhook registered in Stripe Dashboard (test mode)
- [ ] POST `/api/stripe/checkout` returns a Stripe-hosted checkout URL
- [ ] Complete checkout in Stripe sandbox — webhook fires, Supabase record updated
- [ ] Cancel subscription in Stripe sandbox — webhook fires, `subscription_status=cancelled`, cancellation email sent to Ryoko/Holo

## Frontend integration (G1 dependency)

The pricing page (G1) should POST to `/api/stripe/checkout` with `{ tier, email }` and redirect the browser to the returned `url`. Example:

```js
const res = await fetch('/api/stripe/checkout', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tier: 'starter', email: userEmail }),
});
const { url } = await res.json();
window.location.href = url;
```

## Notes

- Uses Stripe Checkout (hosted page) — Option A from the brief. Simplest path, minimal code.
- No `stripe` npm package needed — direct REST API calls via `fetch`.
- Cancellation email is lightweight HTML via Resend transactional — no extra tool needed.
- Live keys must not be activated until QA sign-off.
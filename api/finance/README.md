# Stripe Overnight Finance Ingestion

## Production surfaces

| Surface | Verified source-controlled location | Runtime service |
|---|---|---|
| Scheduler | `vercel.json` → `/api/finance/stripe-overnight`, `0 0 * * *` | Vercel Cron (UTC) |
| Dedupe store | `supabase/finance-stripe-overnight-schema.sql` → `public.finance_event_dedupe` | Supabase/PostgREST |
| Quiet receipt log | `supabase/finance-stripe-overnight-schema.sql` → `public.quiet_receipt_log` | Supabase/PostgREST |
| Canonical signal persistence | `supabase/finance-stripe-overnight-schema.sql` → `public.finance_signals` via `persist_finance_signals_atomically(jsonb)` | Supabase/PostgREST |

The endpoint implementation is `api/finance/stripe-overnight.js`; read-only Stripe pagination and receipt construction are in `lib/finance-stripe-overnight.mjs`.

## Runtime contract

- Vercel invokes the endpoint daily at 00:00 UTC. The handler independently rejects execution outside UTC 00:00–05:59 and writes a receipt with `mode: outside_window_noop`.
- The handler accepts only authenticated `GET` requests using `Authorization: Bearer $CRON_SECRET`.
- Stripe calls use only `GET` for `/balance`, `/charges`, `/subscriptions?status=all`, and `/balance_transactions`. List sources use `starting_after` until `has_more` is false.
- Dedupe claim and canonical signal insert run through one `security definer` RPC transaction; it is executable only by `service_role`. All three finance tables have RLS enabled with no browser/user policies.
- Dedupe keys retain the mandated template. `event_type` includes the Stripe entity ID (for example `charge.ch_123`) so distinct events of the same Stripe resource type do not collide:
  `finance_event:{account_id}:{event_type}:{date}`.
- Signal keys use the mandated template:
  `finance_signal:{entity_id}:{signal_type}`.

## Required deployment inputs

1. Apply `supabase/finance-stripe-overnight-schema.sql` to the production Supabase project.
2. Set `CRON_SECRET`, `STRIPE_ACCOUNT_ID`, `STRIPE_SECRET_KEY`, and the existing Supabase URL/service-role environment values in the Vercel project.
3. Deploy this source change, then use Vercel's cron/deployment readback and a credentialed outside-window request to verify the durable no-op receipt.

Do not invoke the endpoint with a Stripe mutation method or add a Stripe write call to this workflow.

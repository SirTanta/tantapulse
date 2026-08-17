# Hunter → Atlas ingestion sender

Tanta Pulse is a direct producer into Atlas (the internal CRM). Atlas already
exposes the receiver at `/api/v1/integrations/tanta-pulse`; this is the sender
side plus the durable state that decides whether an event may be produced at
all. Hunter is not a direct CRM integration — it flows only through the Pulse
server runtime, and nothing here is reachable from a browser.

## What was built

| File | Purpose |
|------|---------|
| `supabase/hunter-atlas-ingestion-schema.sql` | List approvals, prospect state, suppressions, and the Atlas delivery ledger |
| `lib/hunter-atlas-gate.mjs` | Fail-closed authorization gate (approval state, run window, cap, stop conditions, suppression) |
| `lib/hunter-atlas-sender.mjs` | Normalized envelopes, HMAC-SHA256 signing, response classification, retry, idempotent delivery |
| `api/hunter/atlas-sync.js` | GET `/api/hunter/atlas-sync` — `CRON_SECRET`-gated delivery drain over the ledger |
| `test/hunter-atlas-gate.test.mjs` | Approval / cap / suppression gating |
| `test/hunter-atlas-sender.test.mjs` | Envelope contract, signature, idempotency, retry classification |

## Boundaries this code enforces

- **Server-only.** No browser route, no client-side call, no Hunter receiver in
  the CRM. Delivery originates from the Pulse runtime.
- **No provider payloads cross the boundary.** `assertEnvelopeShape` rejects any
  field outside the contract, and `normalizePayload` strips a fact to contract
  fields before it is persisted. Hunter API responses, list exports and message
  bodies have no path into a payload.
- **Telemetry is not authorization.** An open or a click is rejected as a
  confirmation reference. Only facts in `CONFIRMED_FACT_MAP`, carrying a
  `confirmed_by` reference from the Pulse runtime, are deliverable.
- **Fail closed.** Delivery is refused when the approval is absent, paused,
  stopped, expired, outside its run window, over its cap, misconfigured, or
  blocked by a stop condition — before any network call and before a ledger row
  is claimed.
- **Suppression is a send-side control.** It blocks admission and outreach, is
  read ahead of the approval so resuming a list never resurrects a suppressed
  prospect, and never swallows the `opted_out` event that reports it.
- **Create before stage.** Atlas rejects a non-create event for an unknown lead,
  so a later lifecycle event is withheld until `prospect.verified` is delivered.

## Contract

`POST $CRM_INGESTION_ENDPOINT`, `Content-Type: application/json`,
`X-Tanta-Signature: sha256=<hex>` — HMAC-SHA256 of the exact raw request body
under `HOLDINGS_INGESTION_SECRET`. Both are read from env; neither is hardcoded
and neither reaches a browser.

| Confirmed source fact | `fact.kind` | Event | `lifecycle_stage` |
|---|---|---|---|
| Verified prospect admitted by an active approval | `verified_prospect_admitted` | `prospect.verified` | `new` |
| Approved workflow confirms a send | `outreach_send_confirmed` | `prospect.stage_changed` | `contacted` |
| Approved workflow confirms a reply | `outreach_reply_confirmed` | `prospect.stage_changed` | `replied` |
| Approved workflow records a bounce | `outreach_bounce_recorded` | `prospect.stage_changed` | `bounced` |
| Suppression written after opt-out | `suppression_written` | `prospect.stage_changed` | `opted_out` |
| Approved workflow confirms a meeting | `meeting_confirmed` | `prospect.stage_changed` | `meeting_booked` |
| Owning commerce workflow confirms revenue | `revenue_confirmed` | `prospect.conversion_recorded` | n/a |

`event_id` is a UUID generated once when the outcome is first claimed and reused
verbatim on every retry, keyed by the immutable `outcome_key`
(`hunter:<prospect_id>:<fact_kind>:<outcome_ref>`). `occurred_at` and the
normalized payload are frozen on that first claim, so a retry reproduces a
byte-identical body and therefore an identical signature.

Retries: 5xx / 408 / 429 retry with exponential backoff; 401 and 422 halt the
run for operator review with no blind retry; other 4xx are recorded as rejected.

## Not done here, deliberately

This branch is code and tests only. It does **not** activate anything:

- No Hunter credential is read, and no Hunter API client exists in this repo.
- `api/hunter/atlas-sync.js` is **not** registered in `vercel.json` crons.
  Scheduling it is a separate, deliberate operator change.
- No outbound campaign, sender account, DNS record or audience was touched.
- The handler returns 503 until `CRM_INGESTION_ENDPOINT` and
  `HOLDINGS_INGESTION_SECRET` are present, so an accidental invocation is inert.

## Before going live

1. Apply `supabase/hunter-atlas-ingestion-schema.sql` through the approved
   production Supabase SQL Editor.
2. Set `CRM_INGESTION_ENDPOINT` (final Atlas host) and
   `HOLDINGS_INGESTION_SECRET` in Infisical, routed to Vercel server env only.
3. Insert the first `hunter_list_approvals` row — owner, legal basis, offer and
   message versions, run window, cap, stop conditions. Without it every
   delivery is refused.
4. Only then decide whether to add the cron entry for `/api/hunter/atlas-sync`.

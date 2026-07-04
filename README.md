# Lane 2 — HVAC / Austin TX Pipeline

## Architecture

```
Apify (Google Places, HVAC Austin)
  → trigger.js (spend guard + queue run record)
    → Supabase: lane2_feed_runs (status='capped'|'queued')
  → process.js (poll queue → fetch dataset → score → dedupe → persist)
    → Supabase: lane2_raw_items + lane2_leads + lane2_followup_queue
  → send.js (poll followup_queue → Resend emails)
```

Mirrors TantaPulse exactly; differences are scoped to the Lane 2 niche and
the spend-aware Apify guard.

---

## Database Schema

File: `supabase/lane2-schema.sql`

Apply after TantaPulse schema is already in place:

```bash
psql "$THOS_SUPABASE_DB_URL" -f supabase/lane2-schema.sql
```

Tables:

| Table | Purpose |
|---|---|
| `lane2_feed_runs` | Run tracker (queued / processing / processed / capped) |
| `lane2_raw_items` | Raw scraped items (deduped by payload_hash) |
| `lane2_leads` | Scored + deduped leads with HVAC-specific fields |
| `lane2_followup_queue` | Pending Resend deliveries |
| `lane2_spend_log` | Audit log of every spend check result |

---

## Environment Variables

```env
# Supabase
THOS_SUPABASE_URL=https://your-project.supabase.co
THOS_SUPABASE_SERVICE_KEY=sg.xxx

# Apify
APIFY_TOKEN=apify_api_xxx
LANE2_APIFY_ACTOR_ID=nwua9Gu5YrADL7ZDj        # optional override
LANE2_APIFY_MAX_ITEMS=50                       # items per run (default 50)

# Spend guard
LANE2_APIFY_BUDGET=5.00        # hard cap in USD
LANE2_APIFY_EST_RUN_COST=0.10  # estimated cost per run
LANE2_OVERHEAD_PCT=0.05        # 5% safety buffer (default)

# Scoring
LANE2_LEAD_SCORE_CAP=50        # min lead_score to enqueue for follow-up (default 50)

# Resend
RESEND_API_KEY=re_xxx
```

---

## API Endpoints

### POST /api/lane2/trigger
Launches the Apify HVAC/Austin scrape after spend guard approval.

```bash
curl -X POST https://your-host/api/lane2/trigger \
  -H "Content-Type: application/json"
```

Response (blocked):
```json
{
  "ok": true,
  "allowed": false,
  "state": "capped",
  "reason": "run_cost_exceeds_safe_budget:0.105>4.75",
  "budget_remaining_usd": 4.75,
  "message": "Spend guard blocked..."
}
```

Response (queued):
```json
{
  "ok": true,
  "allowed": true,
  "apify": { "queued": true, "runId": "...", "datasetId": "..." },
  "spend": { "reservation_id": "...", "budget_remaining_usd": 4.65 }
}
```

---

### GET /api/lane2/process
Polls `lane2_feed_runs` for `status='queued'`, fetches Apify datasets,
scores + dedupes, persists to Supabase, enqueues follow-ups.

```bash
curl https://your-host/api/lane2/process
```

Manual mode (POST with items):
```bash
curl -X POST https://your-host/api/lane2/process \
  -H "Content-Type: application/json" \
  -d '{"items": [{"name":"Acme HVAC","city":"Austin","phone":"512-555-0100"}]}'
```

---

### GET /api/lane2/send
Polls `lane2_followup_queue` for due rows, sends via Resend.

```bash
curl https://your-host/api/lane2/send
```

---

### GET /api/lane2/test-cap
Debug endpoint to simulate / verify the spend guard without calling Apify.

```bash
# Simulate a run that would be capped
curl "https://your-host/api/lane2/test-cap?budget=0.05&estCost=0.50"

# Simulate a run that passes
curl "https://your-host/api/lane2/test-cap?budget=5.00&estCost=0.10"
```

---

## Spend Guard Logic

```
GET /v2/users/me/limits  (Apify API)
         ↓
budget_current = limits.currentUsageUsd
budget_remaining = min(availableCredits, budget_cap)
         ↓
protected_budget = budget_cap × (1 − overhead_pct)   # 95% of cap
effective_cost   = est_run_cost × (1 + overhead_pct) # 105% of est
         ↓
if effective_cost > protected_budget → BLOCK (state: capped)
if effective_cost > budget_remaining → BLOCK (state: over_budget)
else → APPROVE, reserve slot, return reservation_id
```

Reservation ID is stored in `lane2_feed_runs.spend_check` for audit.

---

## Scoring (mirrors TantaPulse)

| Dimension | Weight | Signals |
|---|---|---|
| Fit | 45 % | has_name, has_website, has_phone, has_email, matches_niche, matches_city |
| Intent | 30 % | hiring_intent, recent_activity, review_velocity, trigger_event, intent_keywords |
| Quality | 15 % | field_completeness, source_confidence, freshness |
| Engagement | 10 % | review_volume, strong_rating, team_size |

Score band: `high` (≥ 80) → `send_first`, `usable` (≥ 50) → `keep`, `low` → `hold`

---

## Triggering a Run

```bash
# 1. Set env vars (in .env or platform secret manager)
export LANE2_APIFY_BUDGET=5.00

# 2. Fire the trigger
curl -X POST https://your-host/api/lane2/trigger

# 3. Run the processor (after Apify run completes)
curl https://your-host/api/lane2/process

# 4. Send follow-ups
curl https://your-host/api/lane2/send
```

No scheduled triggers are included — wire them via platform cron (Vercel cron,
supabase cron, etc.) as a separate decision.

---

## Testing the Cap

```bash
# Set a tiny budget to force a cap
LANE2_APIFY_BUDGET=0.01 curl "https://your-host/api/lane2/test-cap?budget=0.01&estCost=0.10"
# Expected: allowed=false, state="capped"
```

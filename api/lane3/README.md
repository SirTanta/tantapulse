# Lane 3 — Job Boards (Indeed + LinkedIn)

## Purpose
Collect job listings matching training / L&D / instructional design keywords. These signal hiring demand, budget availability, and company investment in learning infrastructure.

## Keywords (7)
- instructional design
- LMS
- e-learning
- training content
- course creation
- training coordinator
- learning & development

## Sources

| Source | Actor | Est. Cost/Run | Max Items | Notes |
|--------|-------|---------------|-----------|-------|
| Indeed | `borderline/indeed-scraper` | ~$0.59 | 150 | Stable, widely used |
| LinkedIn | `curious_coder/linkedin-jobs-scraper` | ~$1.50 | 100 | Anti-scrape risk — monitor |

## Architecture

```
POST /api/lane3/trigger
  → spend guard (shared cap)
  → for each {source × keyword} pair (14 runs):
    → launch Apify actor
    → create lane3_feed_runs record (queued)

GET /api/lane3/process
  → poll lane3_feed_runs (status='queued')
  → fetch each Apify dataset
  → normalize via field maps (Indeed / LinkedIn shapes)
  → score (fit 40%, intent 30%, quality 20%, engagement 10%)
  → deduplicate (company × title × source)
  → persist to lane3_raw_items + lane3_jobs
```

## Cost

| Sweep | Run Count | Est. Total |
|-------|-----------|------------|
| Full sweep (7 keywords × 2 sources) | 14 runs | ~$14.63 |
| 2x/week | 28 runs/week | ~$29.26/week |
| Monthly est. | ~112 runs | ~$117-130/mo |

## Env Vars

```env
# Apify
APIFY_TOKEN=apify_api_xxx
LANE3_INDEED_ACTOR_ID=borderline/indeed-scraper
LANE3_LINKEDIN_ACTOR_ID=curious_coder/linkedin-jobs-scraper
LANE3_INDEED_MAX_ITEMS=150
LANE3_LINKEDIN_MAX_ITEMS=100

# Spend guard
LANE3_APIFY_BUDGET=25.00
LANE3_APIFY_OVERHEAD_PCT=0.05
LANE3_APIFY_EST_RUN_COST=14.63

# Scoring
LANE3_LEAD_SCORE_CAP=50
```

## API Endpoints

### POST /api/lane3/trigger
Launches all 14 keyword runs.

```bash
curl -X POST https://tantapulse.com/api/lane3/trigger
```

### GET /api/lane3/process
Processes all queued runs.

```bash
curl https://tantapulse.com/api/lane3/process
```

### POST /api/lane3/process (manual test)

```bash
curl -X POST https://tantapulse.com/api/lane3/process \
  -H "Content-Type: application/json" \
  -d '{"source":"indeed","keyword":"instructional design","items":[{"title":"Instructional Designer","company":"Acme Corp"}]}'
```

## Scoring Model

| Dimension | Weight | Signals |
|-----------|--------|---------|
| Fit | 40% | has_company, has_title, keyword_match, niche_relevant |
| Intent | 30% | active_hiring, senior_role, edtech_signal, full_time |
| Quality | 20% | field_completeness, fresh_48h/7d/30d |
| Engagement | 10% | known_company, linkedin_source |

## DB Schema

File: `supabase/lane3-schema.sql`

Tables: lane3_feed_runs, lane3_raw_items, lane3_jobs

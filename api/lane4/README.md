# Lane 4 — Reddit / Forums (r/instructionaldesign, r/elearning)

## Purpose
Monitor instructional design and e-learning communities for buyer-pain signals, hiring needs, LMS dissatisfaction, and course-creation demand. These are early indicators of commercial intent that don't appear on job boards.

## Subreddits

| Subreddit | Focus | Signal Type |
|-----------|-------|-------------|
| r/instructionaldesign | Instructional design career, tools, discussions | Hiring, pain points, tool recommendations |
| r/elearning | E-learning technology, LMS, course creation | Buyer intent, switching signals, budget talk |

## Source

| Source | Actor | Est. Cost/Run | Max Items |
|--------|-------|---------------|-----------|
| Reddit | `drobnikj/download-reddit-entries` | ~$0.10 | 100 |
| Reddit (fallback) | `ph映/downloader` | ~$0.01-0.02 | 100 |

Reddit scraping is the lowest-cost source in the pipeline. A full sweep of both subreddits costs ~$0.20.

## Signal Keywords Detected

- **Buyer intent:** "looking for", "recommend", "alternative", "switching", "replacing"
- **Hiring signals:** "hiring", "job opening", "recruiting", "position available"
- **Pain signals:** "too expensive", "frustrated", "broken", "terrible"
- **Budget signals:** "budget", "vendor", "pricing", "contract"
- **Content signals:** "course creation", "authoring", "curriculum", "content development"

## Architecture

```
POST /api/lane4/trigger
  → spend guard (dedicated cap)
  → for each subreddit (2 runs):
    → launch Apify Reddit actor
    → create lane4_feed_runs record

GET /api/lane4/process
  → poll lane4_feed_runs (status='queued')
  → fetch Apify dataset
  → normalize (Reddit shape → unified)
  → detect signal keywords in title + body
  → score (fit 30%, intent 40%, quality 20%, engagement 10%)
  → deduplicate (post_id × author × subreddit)
  → persist to lane4_raw_items + lane4_posts
```

## Cost

| Sweep | Run Count | Est. Total |
|-------|-----------|------------|
| Full sweep (2 subreddits) | 2 runs | ~$0.20 |
| 2x/week | 4 runs/week | ~$0.40/week |
| Monthly est. | ~16 runs | ~$1.60/mo |

## Env Vars

```env
# Apify
APIFY_TOKEN=apify_api_xxx
LANE4_REDDIT_ACTOR_ID=drobnikj/download-reddit-entries
LANE4_REDDIT_MAX_ITEMS=100
LANE4_REDDIT_EST_COST=0.10

# Spend guard
LANE4_APIFY_BUDGET=5.00
LANE4_APIFY_OVERHEAD_PCT=0.05

# Scoring
LANE4_POST_SCORE_CAP=50
```

## API Endpoints

### POST /api/lane4/trigger

```bash
curl -X POST https://tantapulse.com/api/lane4/trigger
```

### GET /api/lane4/process

```bash
curl https://tantapulse.com/api/lane4/process
```

### POST /api/lane4/process (manual test)

```bash
curl -X POST https://tantapulse.com/api/lane4/process \
  -H "Content-Type: application/json" \
  -d '{"subreddit":"instructionaldesign","items":[{"title":"Looking for LMS recommendations","selftext":"We need to replace our current platform..."}]}'
```

## Scoring Model

| Dimension | Weight | Signals |
|-----------|--------|---------|
| Fit | 30% | has_title, has_body, has_author, signal_keywords |
| Intent | 40% | buyer_intent, hiring_signal, pain_signal, budget_signal |
| Quality | 20% | field_completeness, fresh_24h/72h/week, upvoted, discussed |
| Engagement | 10% | primary_community, strong_sentiment, active_discussion |

## DB Schema

File: `supabase/lane4-schema.sql`

Tables: lane4_feed_runs, lane4_raw_items, lane4_posts

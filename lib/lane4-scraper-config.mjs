/**
 * Lane 4 — Reddit/Forum Scraper Configuration
 *
 * Configures Apify actors for Reddit subreddits: r/instructionaldesign, r/elearning.
 * Mirrors the Lane 2 scraper-config and Lane 3 job-board config patterns.
 *
 * These forums surface buyer-pain signals, LMS dissatisfaction threads,
 * hiring-in-need posts, and niche instructional design conversations.
 *
 * Apify actors:
 *   Reddit: drobnikj/download-reddit-entries (well-known, stable)
 *           or ph映/downloader — fallback if first unavailable
 *
 * Output fields: company_name, job_title, posting_url, posting_date, source, raw_snippet
 * (Reddit posts map to: author → company_name, title → job_title, permalink → posting_url,
 *  created_utc → posting_date, selftext → raw_snippet)
 */

export const SUBREDDITS = [
  { name: "instructionaldesign", label: "r/instructionaldesign" },
  { name: "elearning", label: "r/elearning" },
];

/**
 * Apify actor for Reddit scraping.
 * We provide two options in case one is unavailable.
 */
export const REDDIT_ACTORS = {
  primary: {
    id: process.env.LANE4_REDDIT_ACTOR_ID || "drobnikj/download-reddit-entries",
    name: "Download Reddit Entries",
    defaultMaxItems: Number(process.env.LANE4_REDDIT_MAX_ITEMS || "100"),
    estCostPerRun: Number(process.env.LANE4_REDDIT_EST_COST || "0.10"),
  },
  fallback: {
    id: "ph映/downloader",
    name: "Reddit Downloader",
  },
};

/**
 * Keywords that indicate buyer-pain / hiring / LMS-need signals in posts.
 * Posts matching these get higher intent scores.
 */
export const SIGNAL_KEYWORDS = [
  // Hiring / job-seeking signals
  "hiring", "job", "career", "position", "opening", "recruiting",
  "looking for", "need help", "opportunity", "apply",
  // LMS pain / switching signals
  "LMS", "learning management", "switching from", "moving from",
  "replace", "alternative to", "too expensive", "too complicated",
  "looking for LMS", "recommend an LMS", "LMS recommendation",
  // Course creation / training signals
  "course creation", "create courses", "training content",
  "instructional design", "learning experience", "content development",
  // Buyer intent
  "budget", "vendor", "pricing", "quote", "demo", "trial",
  "implementation", "rollout", "deployment",
];

/**
 * Build Apify actor input for Reddit scraper.
 *
 * @param {object} opts
 * @param {string} opts.subreddit — subreddit name without r/
 * @param {string} opts.searchQuery — optional search query to filter
 * @param {number} opts.maxItems — max posts to fetch
 */
export function buildRedditInput({ subreddit, searchQuery = "", maxItems = 100 } = {}) {
  const input = {
    subreddit: [subreddit],
    maxItems,
    sort: "new",
    includeComments: false,
  };
  if (searchQuery) {
    input.searchQuery = searchQuery;
  }
  return input;
}

/**
 * Field mapping: Apify Reddit output → TantaPulse fields
 *
 * Reddit output typically has: title, selftext, author, subreddit,
 * created_utc, url, permalink, score, num_comments, upvoteRatio
 */
export const REDDIT_FIELD_MAP = {
  title:         "job_title",           // post title as "job title" analog
  author:        "company_name",         // author as "company" analog
  name:          "company_name",
  subreddit:     "subreddit",
  created_utc:   "posting_date",
  created:       "posting_date",
  selftext:      "raw_snippet",
  text:          "raw_snippet",
  url:           "posting_url",
  permalink:     "posting_url",
  permalink_url: "posting_url",
  score:         "upvotes",
  num_comments:  "comment_count",
  upvoteRatio:   "upvote_ratio",
  source:        "source",
  collectedAt:   "collected_at",
};

/**
 * Normalize a raw Apify Reddit item into a standard forum post record.
 *
 * @param {object} item — raw item from Apify dataset
 * @param {object} context — { source, subreddit, collectedAt }
 * @returns {object} — normalized forum post record
 */
export function normalizeRedditItem(item = {}, context = {}) {
  const raw = item.raw ?? item;
  const now = context.collectedAt || new Date().toISOString();

  // Convert created_utc (epoch seconds) to ISO string
  let postingDate = raw.created_utc || raw.created || null;
  if (postingDate && typeof postingDate === "number") {
    postingDate = new Date(postingDate * 1000).toISOString();
  } else if (postingDate && typeof postingDate === "string" && !postingDate.includes("T")) {
    // Might be epoch as string
    const ts = Number(postingDate);
    if (!Number.isNaN(ts) && ts > 1000000000) {
      postingDate = new Date(ts * 1000).toISOString();
    }
  }

  // Build proper Reddit URL
  const subreddit = raw.subreddit || context.subreddit || "";
  let postingUrl = raw.url || raw.permalink || "";
  if (!postingUrl && subreddit && raw.id) {
    postingUrl = `https://www.reddit.com/r/${subreddit}/comments/${raw.id}/`;
  }

  const title = String(raw.title || "").trim();
  const selftext = String(raw.selftext || raw.text || raw.description || "").trim().slice(0, 5000);

  // Detect if this post contains signal keywords
  const searchText = `${title} ${selftext}`.toLowerCase();
  const matchedSignals = SIGNAL_KEYWORDS.filter((kw) => searchText.includes(kw));

  return {
    job_title:            title,
    company_name:         String(raw.author || "").trim(),
    posting_url:          postingUrl,
    posting_date:         postingDate,
    subreddit:            subreddit || raw.subreddit || "",
    raw_snippet:          selftext.slice(0, 2000),
    source:               "reddit",
    upvotes:              Number(raw.score || raw.ups || 0),
    comment_count:        Number(raw.num_comments || raw.commentCount || raw.comments || 0),
    upvote_ratio:         typeof raw.upvoteRatio === "number" ? raw.upvoteRatio : null,
    post_id:              raw.id || "",
    matched_signals:      matchedSignals,
    signal_count:         matchedSignals.length,
    collected_at:         now,
    raw_item:             item,
  };
}

/**
 * Generate all search configs for Lane 4.
 * Returns one config per subreddit (can add keyword-scoped variants later).
 *
 * @returns {Array<{source: string, subreddit: string, actorId: string, input: object, maxItems: number}>}
 */
export function generateAllSubredditConfigs() {
  return SUBREDDITS.map((sr) => ({
    source: "reddit",
    subreddit: sr.name,
    label: sr.label,
    actorId: REDDIT_ACTORS.primary.id,
    input: buildRedditInput({ subreddit: sr.name, maxItems: REDDIT_ACTORS.primary.defaultMaxItems }),
    maxItems: REDDIT_ACTORS.primary.defaultMaxItems,
    estCost: REDDIT_ACTORS.primary.estCostPerRun,
  }));
}

/**
 * Estimate total cost for one full Lane 4 sweep.
 */
export function estimateSweepCost() {
  const perSubreddit = REDDIT_ACTORS.primary.estCostPerRun;
  const count = SUBREDDITS.length;
  return {
    totalEstUsd: perSubreddit * count,
    perSubreddit,
    subredditCount: count,
    note: "Reddit scraping is very low cost. 2x/week = pennies.",
  };
}

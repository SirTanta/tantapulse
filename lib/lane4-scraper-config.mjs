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
 * drobnikj/download-reddit-entries — DEPRECATED / removed from Apify store (2026-07)
 * trudax/reddit-scraper — active community actor (14K users, $45/mo + usage)
 */
export const REDDIT_ACTORS = {
  primary: {
    id: process.env.LANE4_REDDIT_ACTOR_ID || "trudax/reddit-scraper",
    name: "Reddit Scraper",
    defaultMaxItems: Number(process.env.LANE4_REDDIT_MAX_ITEMS || "100"),
    estCostPerRun: Number(process.env.LANE4_REDDIT_EST_COST || "0.50"),
  },
  fallback: {
    id: "parseforge/reddit-posts-scraper",
    name: "Reddit Posts Scraper",
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
 * Build Apify actor input for Reddit scraper (trudax/reddit-scraper).
 *
 * Input schema for trudax/reddit-scraper:
 *   subreddits: string[]     — subreddit names (without r/)
 *   sort?: string            — "new" | "hot" | "top" | "rising" | "relevance" | "comments"
 *   maxItems?: number        — max total items
 *   maxPostCount?: number    — max posts per subreddit (default 25)
 *   includeNSFW?: boolean
 *   includeMediaLinks?: boolean
 *   time?: string            — "hour" | "day" | "week" | "month" | "year" | "all"
 *
 * @param {object} opts
 * @param {string} opts.subreddit — subreddit name without r/
 * @param {string} opts.searchQuery — optional search query (NOT USED — kept for compat)
 * @param {number} opts.maxItems — max items per subreddit
 */
export function buildRedditInput({ subreddit, searchQuery = "", maxItems = 100 } = {}) {
  const input = {
    subreddits: [subreddit],
    sort: "new",
    maxItems,
    maxPostCount: Math.min(maxItems, 100),
  };
  return input;
}

/**
 * Field mapping: Apify Reddit output → TantaPulse fields
 *
 * trudax/reddit-scraper output fields:
 *   id, url, username, title, communityName, numberOfComments,
 *   upVotes, upVoteRatio, imageUrls, createdAt, dataType, selfText, etc.
 *
 * Reddit output typically has: title, selftext, author, subreddit,
 * created_utc, url, permalink, score, num_comments, upvoteRatio
 */
export const REDDIT_FIELD_MAP = {
  title:         "job_title",
  author:        "company_name",        // legacy fallback
  username:      "company_name",         // trudax primary
  name:          "company_name",
  subreddit:     "subreddit",           // legacy fallback
  communityName: "subreddit",           // trudax primary (e.g. "r/instructionaldesign")
  created_utc:   "posting_date",
  createdAt:     "posting_date",        // trudax primary (ISO 8601)
  selftext:      "raw_snippet",         // legacy
  selfText:      "raw_snippet",         // trudax primary
  text:          "raw_snippet",
  url:           "posting_url",
  permalink:     "posting_url",
  permalink_url: "posting_url",
  score:         "upvotes",
  upVotes:       "upvotes",            // trudax primary
  num_comments:  "comment_count",
  numberOfComments: "comment_count",   // trudax primary
  upvoteRatio:   "upvote_ratio",
  upVoteRatio:   "upvote_ratio",       // trudax primary
  source:        "source",
  collectedAt:   "collected_at",
};

/**
 * Normalize a raw Apify Reddit item into a standard forum post record.
 * Handles both trudax/reddit-scraper field names and legacy drobnikj format.
 *
 * trudax primary fields:  username, communityName, createdAt, selfText, upVotes, numberOfComments, upVoteRatio
 * legacy drobnikj fields: author, subreddit, created_utc, selftext, score, num_comments, upvoteRatio
 *
 * @param {object} item — raw item from Apify dataset
 * @param {object} context — { source, subreddit, collectedAt }
 * @returns {object} — normalized forum post record
 */
export function normalizeRedditItem(item = {}, context = {}) {
  const raw = item.raw ?? item;
  const now = context.collectedAt || new Date().toISOString();

  // --- subreddit (handle both formats) ---
  const subreddit =
    raw.communityName || // trudax: "r/instructionaldesign"
    raw.subreddit ||     // legacy: "instructionaldesign"
    context.subreddit ||
    "";

  // Strip "r/" prefix if present for consistency
  const subredditClean = subreddit.startsWith("r/")
    ? subreddit.slice(2)
    : subreddit;

  // --- post date (handle ISO string and epoch seconds) ---
  let postingDate = raw.createdAt || raw.created_utc || raw.created || null;
  if (postingDate) {
    if (typeof postingDate === "string" && postingDate.includes("T")) {
      // Already ISO 8601 — trudax format
      postingDate = postingDate;
    } else if (typeof postingDate === "number" || (typeof postingDate === "string" && !postingDate.includes("T"))) {
      // Epoch seconds — legacy drobnikj format
      const ts = typeof postingDate === "number" ? postingDate : Number(postingDate);
      if (!Number.isNaN(ts) && ts > 1000000000) {
        postingDate = new Date(ts * 1000).toISOString();
      }
    }
  }

  // --- company_name (handle both formats) ---
  const companyName =
    raw.username ||    // trudax
    raw.author ||     // legacy
    raw.name ||
    "";

  // --- upvotes ---
  const upvotes = Number(raw.upVotes ?? raw.score ?? raw.ups ?? 0);

  // --- comment_count ---
  const commentCount = Number(
    raw.numberOfComments ?? raw.num_comments ?? raw.commentCount ?? raw.comments ?? 0
  );

  // --- upvote_ratio ---
  const upvoteRatio =
    typeof raw.upVoteRatio === "number"
      ? raw.upVoteRatio
      : typeof raw.upvoteRatio === "number"
      ? raw.upvoteRatio
      : null;

  // --- post URL ---
  let postingUrl = raw.url || raw.permalink || "";
  if (!postingUrl && subredditClean && raw.id) {
    postingUrl = `https://www.reddit.com/r/${subredditClean}/comments/${raw.id}/`;
  }

  const title = String(raw.title || "").trim();
  const selftext = String(raw.selfText || raw.selftext || raw.text || raw.description || "").trim().slice(0, 5000);

  // Detect signal keywords
  const searchText = `${title} ${selftext}`.toLowerCase();
  const matchedSignals = SIGNAL_KEYWORDS.filter((kw) => searchText.includes(kw));

  return {
    job_title:       title,
    company_name:    String(companyName).trim(),
    posting_url:     postingUrl,
    posting_date:    postingDate,
    subreddit:       subredditClean,
    raw_snippet:     selftext.slice(0, 2000),
    source:          "reddit",
    upvotes,
    comment_count:   commentCount,
    upvote_ratio:    upvoteRatio,
    post_id:         raw.id || "",
    matched_signals: matchedSignals,
    signal_count:   matchedSignals.length,
    collected_at:    now,
    raw_item:        item,
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

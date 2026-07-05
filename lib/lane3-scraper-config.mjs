/**
 * Lane 3 — Job Board Scraper Configuration
 *
 * Configures Apify actors for Indeed and LinkedIn Jobs.
 * Mirrors the Lane 2 scraper-config pattern.
 *
 * Keywords: instructional design, LMS, e-learning, training content,
 *           course creation, training coordinator, learning & development
 *
 * Output fields (normalized): company_name, job_title, posting_url,
 *                             posting_date, source, raw_snippet
 *
 * Apify actors:
 *   Indeed:    borderline/indeed-scraper  (well-known, stable)
 *   LinkedIn:  curious_coder/linkedin-jobs-scraper (well-known, moderate anti-scrape)
 */

export const SEARCH_KEYWORDS = [
  "instructional design",
  "LMS",
  "e-learning",
  "training content",
  "course creation",
  "training coordinator",
  "learning & development",
];

export const SOURCE_ACTORS = {
  indeed: {
    id: process.env.LANE3_INDEED_ACTOR_ID || "borderline/indeed-scraper",
    name: "Indeed Jobs",
    defaultMaxItems: Number(process.env.LANE3_INDEED_MAX_ITEMS || "150"),
    estCostPerRun: Number(process.env.LANE3_INDEED_EST_COST || "0.59"),
  },
  linkedin: {
    id: process.env.LANE3_LINKEDIN_ACTOR_ID || "curious_coder/linkedin-jobs-scraper",
    name: "LinkedIn Jobs",
    defaultMaxItems: Number(process.env.LANE3_LINKEDIN_MAX_ITEMS || "100"),
    estCostPerRun: Number(process.env.LANE3_LINKEDIN_EST_COST || "1.50"),
  },
};

/**
 * Build the Apify actor input for Indeed scraper.
 * @param {object} opts
 * @param {string} opts.keyword — search keyword
 * @param {number} opts.maxItems — max results to fetch
 */
export function buildIndeedInput({ keyword, maxItems = 150 } = {}) {
  return {
    search: keyword,
    maxResults: maxItems,
    // No location filter — national remote + major metro signals
    // Add location field here if geography-restricted
  };
}

/**
 * Build the Apify actor input for LinkedIn Jobs scraper.
 * @param {object} opts
 * @param {string} opts.keyword — search keyword
 * @param {number} opts.maxItems — max results to fetch
 */
export function buildLinkedInInput({ keyword, maxItems = 100 } = {}) {
  return {
    query: keyword,
    maxItems,
    // LinkedIn can benefit from geo filtering; leave open for now
  };
}

/**
 * Field mapping: Apify Indeed actor output → TantaPulse normalizeLead fields
 * Indeed output typically has: title, company, location, salary, summary, postedDate
 */
export const INDEED_FIELD_MAP = {
  title:        "job_title",
  company:      "company_name",
  companyName:  "company_name",
  location:     "location",
  salary:       "salary",
  summary:      "raw_snippet",
  description:  "raw_snippet",
  postedDate:   "posting_date",
  date:         "posting_date",
  url:          "posting_url",
  link:         "posting_url",
  jobUrl:       "posting_url",
  source:       "source",
  sourceUrl:    "posting_url",
  collectedAt:  "collected_at",
};

/**
 * Field mapping: Apify LinkedIn Jobs actor output → TantaPulse normalizeLead fields
 * LinkedIn output typically has: title, company, location, level, postedDate, description
 */
export const LINKEDIN_FIELD_MAP = {
  title:          "job_title",
  company:        "company_name",
  companyName:    "company_name",
  company_name:   "company_name",
  location:       "location",
  workplaceType:  "workplace_type",
  jobLevel:       "job_level",
  description:    "raw_snippet",
  summary:        "raw_snippet",
  postedDate:     "posting_date",
  date:           "posting_date",
  postingDate:    "posting_date",
  url:            "posting_url",
  link:           "posting_url",
  jobPostingUrl:  "posting_url",
  source:         "source",
  sourceUrl:      "posting_url",
  collectedAt:    "collected_at",
  companyUrl:     "company_url",
  companyLogo:    "company_logo",
};

/**
 * Normalize a raw Apify item from ANY Lane 3 source into a standard job record.
 * Uses field maps above to handle both Indeed and LinkedIn shapes.
 *
 * @param {object} item — raw item from Apify dataset
 * @param {object} context — { source, keyword, collectedAt }
 * @returns {object} — normalized job record
 */
export function normalizeJobItem(item = {}, context = {}) {
  const source = context.source || "indeed";
  const fieldMap = source === "linkedin" ? LINKEDIN_FIELD_MAP : INDEED_FIELD_MAP;
  const raw = item.raw ?? item;

  // Apply field mapping
  const mapped = {};
  for (const [apifyField, tpField] of Object.entries(fieldMap)) {
    if (raw[apifyField] !== undefined && raw[apifyField] !== null) {
      mapped[tpField] = raw[apifyField];
    }
  }

  const now = context.collectedAt || new Date().toISOString();

  return {
    job_title:        String(mapped.job_title || raw.title || "").trim(),
    company_name:     String(mapped.company_name || raw.company || "").trim(),
    posting_url:      String((mapped.posting_url || raw.url || raw.link || "").trim()),
    posting_date:     mapped.posting_date || raw.date || raw.postedDate || null,
    location:         String(mapped.location || raw.location || "").trim(),
    salary:           String(mapped.salary || "").trim(),
    raw_snippet:      String(mapped.raw_snippet || raw.description || raw.summary || "").slice(0, 2000),
    source:           source,
    keyword:          context.keyword || "",
    workplace_type:   mapped.workplace_type || raw.workplaceType || "",
    job_level:        mapped.job_level || raw.jobLevel || "",
    company_url:      String(mapped.company_url || "").trim(),
    company_logo:     String(mapped.company_logo || "").trim(),
    collected_at:     now,
    // Original item preserved for re-scoring
    raw_item:         item,
  };
}

/**
 * Generate all keyword search configurations for all sources.
 * Each combination of { source × keyword } becomes a scheduled trigger input.
 *
 * @returns {Array<{source: string, actorId: string, keyword: string, input: object, maxItems: number}>}
 */
export function generateAllSearchConfigs() {
  const configs = [];

  for (const keyword of SEARCH_KEYWORDS) {
    // Indeed config
    configs.push({
      source: "indeed",
      actorId: SOURCE_ACTORS.indeed.id,
      keyword,
      input: buildIndeedInput({ keyword, maxItems: SOURCE_ACTORS.indeed.defaultMaxItems }),
      maxItems: SOURCE_ACTORS.indeed.defaultMaxItems,
      estCost: SOURCE_ACTORS.indeed.estCostPerRun,
    });

    // LinkedIn config
    configs.push({
      source: "linkedin",
      actorId: SOURCE_ACTORS.linkedin.id,
      keyword,
      input: buildLinkedInInput({ keyword, maxItems: SOURCE_ACTORS.linkedin.defaultMaxItems }),
      maxItems: SOURCE_ACTORS.linkedin.defaultMaxItems,
      estCost: SOURCE_ACTORS.linkedin.estCostPerRun,
    });
  }

  return configs;
}

/**
 * Estimate total cost for one full sweep of all keywords across all sources.
 * @returns {{ totalEstUsd: number, perKeyword: number, sourceBreakdown: object }}
 */
export function estimateSweepCost() {
  const indeedCostPer = SOURCE_ACTORS.indeed.estCostPerRun;
  const linkedinCostPer = SOURCE_ACTORS.linkedin.estCostPerRun;
  const keywordCount = SEARCH_KEYWORDS.length;

  return {
    totalEstUsd: (indeedCostPer + linkedinCostPer) * keywordCount,
    perKeyword: indeedCostPer + linkedinCostPer,
    sourceBreakdown: {
      indeed: `${indeedCostPer.toFixed(2)}/run × ${keywordCount} keywords = $${(indeedCostPer * keywordCount).toFixed(2)}`,
      linkedin: `${linkedinCostPer.toFixed(2)}/run × ${keywordCount} keywords = $${(linkedinCostPer * keywordCount).toFixed(2)}`,
    },
    keywordCount,
    note: "Per-sweep cost (2x/week = 2× this per week)",
  };
}

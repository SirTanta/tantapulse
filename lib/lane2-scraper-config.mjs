/**
 * Lane 2 — Apify HVAC scraper configuration for Austin TX.
 *
 * This module exports the reusable scraper config for the Google Places
 * actor (apify/google-places-scraper or equivalent).
 *
 * The trigger handler imports this and merges it with the spend guard
 * before calling the Apify Actor API.
 */

export const SCRAPER_CONFIG = {
  // Niche / vertical
  niche: "HVAC",
  city:  "Austin",
  state: "TX",

  // Apify actor: Google Places Multi-Crawl Runner
  // Stable actor ID — replace with your tenant's actor if needed.
  actorId: process.env.LANE2_APIFY_ACTOR_ID || "nwua9Gu5YrADL7ZDj",

  // Default dataset item limit per run
  maxItems: Number(process.env.LANE2_APIFY_MAX_ITEMS || "50"),

  // Search string passed to the actor
  buildSearchString({ niche = "HVAC", city = "Austin", state = "TX" } = {}) {
    return `${niche} in ${city}, ${state}`;
  },

  // Additional actor input fields for HVAC-specific filtering
  buildActorInput({ searchString, maxItems, proxyConfig = { useApifyProxy: true } } = {}) {
    return {
      searchString,
      maxCrawledPlaces: maxItems,
      proxyConfig,
      // Filter to only businesses with a website (higher-quality leads)
      onlyWithWebsite: false,
      // Include reviews to extract review_velocity and social_proof_signal signals
      includeReviews: true,
      includeReviewsImages: false,
      // Sort by relevance (not just proximity)
      sortBy: "relevance",
    };
  },

  // Column mapping: Apify Google Places output → TantaPulse normalizeLead fields
  fieldMap: {
    // Apify field          → TantaPulse field
    name:                  "business_name",
    title:                 "business_name",
    company_name:          "business_name",
    website:               "website",
    domain:                "website",
    phone:                 "phone",
    telephone:            "phone",
    contact_phone:         "phone",
    email:                 "email",
    contact_email:         "email",
    address:              "address",
    city:                 "city",
    location:             "city",       // fallback
    locality:            "city",
    state:                "state",
    zipCode:              "zip",
    zip_code:             "zip",
    postalCode:           "zip",
    categories:           "categories",
    categoryName:         "niche",
    rating:               "rating",
    reviewsCount:         "reviews_count",
    review_count:         "reviews_count",
    reviews_count:        "reviews_count",
    numberOfReviews:      "reviews_count",
    openingHours:         "hours",
    workingHours:         "hours",
    priceLevel:           "price_level",
    images:               "images",
    image:                "image",
    logo:                 "logo",
    // Review-related (derived from included reviews)
    averageRating:        "rating",
    // Business signals
    isOpenNow:            "is_open_now",
    servesCuisine:       "hvac_type",   // 'residential'/'commercial' via post-processing
    // Review velocity signals (extracted from recent reviews)
    recentReviewCount:    "recent_review_count",
    reviewVelocitySignal: "review_velocity",
    // Intent signals (from review text — processed in enrichment step)
    hiring_intent:        false,
    recent_activity:      false,
    pricing_signal:       false,
    social_proof_signal: false,
    trigger_event:        false,
    // Metadata
    cid:                  "place_id",
    placeId:              "place_id",
    url:                  "source_url",
    sourceUrl:            "source_url",
    link:                 "source_url",
    collectedAt:          "collected_at",
    timestamp:            "collected_at",
  },
};

/**
 * Post-process raw Apify items before feeding into the Lane 2 scoring pipeline.
 * Adds HVAC-specific derived fields.
 *
 * @param {object} item — raw Apify Google Places item
 * @returns {object} — enriched item ready for normalizeLead
 */
export function enrichHvacItem(item = {}) {
  const raw = item.raw ?? item;
  const now = new Date();

  // Infer HVAC type from categories / title keywords
  const categoryText = [
    raw.categories,
    raw.categoryName,
    raw.title,
    raw.name,
    raw.servesCuisine,
  ].filter(Boolean).join(" ").toLowerCase();

  let hvacType = "both";
  if (/\b(commercial|industrial|contractor)\b/.test(categoryText)) {
    hvacType = "commercial";
  } else if (/\b(residential|home|household)\b/.test(categoryText)) {
    hvacType = "residential";
  }

  // Detect emergency service
  const emergencyKeywords = ["24 hour", "24hr", "emergency", "urgent", "same day"];
  const hasEmergency = emergencyKeywords.some(
    (kw) => categoryText.includes(kw) || (raw.emergencyService === true)
  );

  // Extract years in business (from review patterns or place data)
  const yearsInBusiness = Number.isFinite(raw.yearsInBusiness)
    ? Number(raw.yearsInBusiness)
    : null;

  // Normalize services array
  const services = Array.isArray(raw.services)
    ? raw.services
    : raw.services
      ? String(raw.services).split(",").map((s) => s.trim())
      : [];

  return {
    ...item,
    hvac_type: hvacType,
    emergency_service: hasEmergency,
    services,
    years_in_business: yearsInBusiness,
    niche: "HVAC",
    city: "Austin",
    state: "TX",
    collected_at: raw.collectedAt || raw.timestamp || now.toISOString(),
  };
}

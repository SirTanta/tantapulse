import crypto from "node:crypto";

const WORD_CLEANUP = /[^a-z0-9\s.-]/gi;
const MULTISPACE = /\s+/g;

export function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(MULTISPACE, " ")
    .trim();
}

export function slugify(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(WORD_CLEANUP, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function normalizeDomain(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return "";
  try {
    const url = text.startsWith("http://") || text.startsWith("https://") ? new URL(text) : new URL(`https://${text}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return text.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split(":")[0];
  }
}

export function normalizePhone(value) {
  const raw = normalizeText(value).replace(/[^\d+]/g, "");
  if (!raw) return "";
  if (raw.startsWith("+")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return digits;
}

export function sha1(input) {
  return crypto.createHash("sha1").update(String(input ?? "")).digest("hex");
}

export function stableGroupId(...parts) {
  return sha1(parts.filter(Boolean).join("|")).slice(0, 16);
}

function scoreFit(record, context) {
  let score = 0;
  const reasons = [];
  if (record.business_name) {
    score += 10;
    reasons.push("has_name");
  }
  if (record.website) {
    score += 20;
    reasons.push("has_website");
  }
  if (record.phone) {
    score += 10;
    reasons.push("has_phone");
  }
  if (record.email) {
    score += 10;
    reasons.push("has_email");
  }
  if (record.city) {
    score += 10;
    reasons.push("has_city");
  }
  if (record.niche) {
    score += 10;
    reasons.push("has_niche");
  }
  const searchText = `${record.business_name} ${record.niche} ${record.city} ${record.website} ${context.niche} ${context.city}`.toLowerCase();
  if (context.niche && searchText.includes(String(context.niche).toLowerCase())) {
    score += 15;
    reasons.push("matches_niche");
  }
  if (context.city && searchText.includes(String(context.city).toLowerCase())) {
    score += 15;
    reasons.push("matches_city");
  }
  return { score: clamp(score), reasons };
}

function scoreIntent(record) {
  let score = 0;
  const reasons = [];
  const positives = [
    [record.hiring_intent, 15, "hiring_intent"],
    [record.recent_activity, 10, "recent_activity"],
    [record.review_velocity, 8, "review_velocity"],
    [record.pricing_signal, 8, "pricing_signal"],
    [record.social_proof_signal, 8, "social_proof_signal"],
    [record.trigger_event, 12, "trigger_event"],
  ];
  for (const [flag, points, reason] of positives) {
    if (flag) {
      score += points;
      reasons.push(reason);
    }
  }
  const signalText = `${record.title} ${record.description} ${record.notes} ${record.keywords}`.toLowerCase();
  if (/hiring|growth|expanding|opening|campaign|new location|request a quote/.test(signalText)) {
    score += 12;
    reasons.push("intent_keywords");
  }
  return { score: clamp(score), reasons };
}

function scoreQuality(record) {
  let score = 0;
  const reasons = [];
  const fields = [
    record.business_name,
    record.website,
    record.phone,
    record.email,
    record.city,
    record.source_url,
    record.collected_at,
  ];
  score += fields.filter(Boolean).length * 8;
  if (record.source_confidence) {
    score += 8;
    reasons.push("source_confidence");
  }
  if (record.extraction_confidence) {
    score += 8;
    reasons.push("extraction_confidence");
  }
  if (record.freshness_hours !== null && record.freshness_hours !== undefined && Number.isFinite(record.freshness_hours)) {
    if (record.freshness_hours <= 24) {
      score += 12;
      reasons.push("fresh_24h");
    } else if (record.freshness_hours <= 72) {
      score += 6;
      reasons.push("fresh_72h");
    }
  }
  return { score: clamp(score), reasons };
}

function scoreEngagement(record) {
  let score = 0;
  const reasons = [];
  if (Number(record.reviews_count || record.review_count || 0) >= 20) {
    score += 8;
    reasons.push("review_volume");
  }
  if (Number(record.rating || 0) >= 4.2) {
    score += 6;
    reasons.push("strong_rating");
  }
  if (Number(record.employee_count || 0) >= 5) {
    score += 4;
    reasons.push("team_size");
  }
  if (record.previous_response || record.reply_count || record.engagement_signal) {
    score += 12;
    reasons.push("engagement_signal");
  }
  return { score: clamp(score), reasons };
}

export function normalizeLead(item = {}, context = {}) {
  const collectedAt = normalizeText(item.collected_at || item.collectedAt || item.timestamp || context.collectedAt || new Date().toISOString());
  const website = normalizeDomain(item.website || item.domain || item.url || item.source_url || item.sourceUrl || item.link);
  const businessName = normalizeText(item.business_name || item.company_name || item.name || item.organization || item.title || item.businessName);
  const niche = normalizeText(item.niche || item.category || item.industry || context.niche || "");
  const city = normalizeText(item.city || item.location || item.locality || context.city || "");
  const phone = normalizePhone(item.phone || item.phone_number || item.contact_phone || item.telephone);
  const email = normalizeText(item.email || item.contact_email || item.contactEmail).toLowerCase();
  const sourceUrl = normalizeText(item.source_url || item.sourceUrl || item.url || item.link || "");
  const title = normalizeText(item.title || item.role || item.heading || "");
  const description = normalizeText(item.description || item.summary || item.body || "");
  const keywords = normalizeText(Array.isArray(item.keywords) ? item.keywords.join(" ") : item.keywords || "");
  const notes = normalizeText(item.notes || item.note || "");
  const source = normalizeText(item.source || item.source_type || item.sourceType || context.source || "apify");
  const sourceType = normalizeText(item.source_type || item.sourceType || context.sourceType || source);
  const sourceConfidence = Number.isFinite(Number(item.source_confidence)) ? Number(item.source_confidence) : null;
  const extractionConfidence = Number.isFinite(Number(item.extraction_confidence)) ? Number(item.extraction_confidence) : null;
  const freshnessHours = Number.isFinite(Number(item.freshness_hours)) ? Number(item.freshness_hours) : null;
  const record = {
    business_name: businessName,
    niche,
    city,
    website,
    phone,
    email,
    source_url: sourceUrl,
    collected_at: collectedAt,
    source,
    source_type: sourceType,
    title,
    description,
    keywords,
    notes,
    rating: item.rating ?? null,
    reviews_count: item.reviews_count ?? item.review_count ?? null,
    employee_count: item.employee_count ?? null,
    revenue_band: item.revenue_band ?? null,
    source_confidence: sourceConfidence,
    extraction_confidence: extractionConfidence,
    freshness_hours: freshnessHours,
    hiring_intent: Boolean(item.hiring_intent || item.hiringIntent),
    recent_activity: Boolean(item.recent_activity || item.recentActivity),
    review_velocity: Boolean(item.review_velocity || item.reviewVelocity),
    pricing_signal: Boolean(item.pricing_signal || item.pricingSignal),
    social_proof_signal: Boolean(item.social_proof_signal || item.socialProofSignal),
    trigger_event: Boolean(item.trigger_event || item.triggerEvent),
    previous_response: Boolean(item.previous_response || item.previousResponse),
    reply_count: item.reply_count ?? item.replyCount ?? 0,
    engagement_signal: Boolean(item.engagement_signal || item.engagementSignal),
    raw: item,
  };
  record.fingerprint = stableGroupId(record.business_name, record.website, record.phone, record.email, record.city);
  return record;
}

export function scoreLead(record, context = {}) {
  const fit = scoreFit(record, context);
  const intent = scoreIntent(record);
  const quality = scoreQuality(record);
  const engagement = scoreEngagement(record);
  const score = clamp(Math.round((fit.score * 0.45) + (intent.score * 0.3) + (quality.score * 0.15) + (engagement.score * 0.1)));
  const band = score >= 80 ? "high" : score >= 50 ? "usable" : "low";
  const action = score >= 80 ? "send_first" : score >= 50 ? "keep" : "hold";
  const reasons = [...new Set([...fit.reasons, ...intent.reasons, ...quality.reasons, ...engagement.reasons])];
  return {
    lead_score: score,
    score_band: band,
    recommended_action: action,
    score_breakdown: {
      fit: fit.score,
      intent: intent.score,
      quality: quality.score,
      engagement: engagement.score,
    },
    score_reasons: reasons,
  };
}

export function processBatch(items = [], context = {}) {
  const normalized = items.map((item) => {
    const record = normalizeLead(item, context);
    const scoring = scoreLead(record, context);
    const duplicateGroupId = stableGroupId(record.business_name, record.website || record.phone || record.email || record.fingerprint, record.city || context.city || "");
    return {
      ...record,
      ...scoring,
      duplicate_group_id: duplicateGroupId,
      canonical_entity_id: duplicateGroupId,
      raw_item_hash: sha1(JSON.stringify(item || {})),
    };
  });

  const deduped = new Map();
  for (const record of normalized) {
    const key = record.duplicate_group_id;
    const current = deduped.get(key);
    if (!current || Number(record.lead_score) > Number(current.lead_score)) {
      deduped.set(key, record);
    }
  }

  const kept = [...deduped.values()].sort((a, b) => Number(b.lead_score) - Number(a.lead_score));
  const counts = {
    total: normalized.length,
    unique: kept.length,
    high: normalized.filter((r) => r.score_band === "high").length,
    usable: normalized.filter((r) => r.score_band === "usable").length,
    low: normalized.filter((r) => r.score_band === "low").length,
    duplicate_rate: normalized.length ? Number(((normalized.length - kept.length) / normalized.length).toFixed(3)) : 0,
    average_score: normalized.length ? Number((normalized.reduce((sum, row) => sum + Number(row.lead_score || 0), 0) / normalized.length).toFixed(1)) : 0,
  };

  return {
    context,
    counts,
    items: normalized,
    unique_items: kept,
    top_items: kept.slice(0, 10),
    score_thresholds: {
      instant_alert: 80,
      nurture: 60,
      hold: 40,
    },
    routing: {
      instant_alert: kept.filter((r) => r.lead_score >= 80).length,
      nurture: kept.filter((r) => r.lead_score >= 60 && r.lead_score < 80).length,
      hold: kept.filter((r) => r.lead_score < 60).length,
    },
  };
}

export function summarizeCounts(batch) {
  return {
    total: batch.counts.total,
    unique: batch.counts.unique,
    high: batch.counts.high,
    usable: batch.counts.usable,
    low: batch.counts.low,
    duplicate_rate: batch.counts.duplicate_rate,
    average_score: batch.counts.average_score,
    top_score: batch.top_items[0]?.lead_score ?? null,
    top_action: batch.top_items[0]?.recommended_action ?? null,
  };
}

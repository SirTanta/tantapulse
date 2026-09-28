import { createHash } from "node:crypto";

export const PLANS = [
  {
    tier: "starter",
    name: "Starter",
    price: "$49/mo",
    url: "https://buy.stripe.com/aFa00c74H8i0ghZ12j5J605",
  },
  {
    tier: "pro",
    name: "Pro",
    price: "$149/mo",
    url: "https://buy.stripe.com/4gMdR274HeGo5Dl3ar5J606",
  },
  {
    tier: "agency",
    name: "Agency",
    price: "$399/mo",
    url: "https://buy.stripe.com/aFadR2cp1bucghZfXd5J607",
  },
];

export const FROM = "Tanta Pulse <noreply@tantaholdings.com>";
// hello@tantapulse.com has no reader (MCA-804 cancelled); replies and ops alerts must land in a monitored inbox.
export const MONITORED_INBOX = "jedwards@tanta-holdings.com";
export const REPLY_TO = MONITORED_INBOX;
export const OPS_EMAIL = MONITORED_INBOX;
export const APIFY_ACTOR = "compass~crawler-google-places";
export const PLACES_PER_SCRAPE = 40;
export const SAMPLE_PREVIEW_COUNT = 10;
export const PAID_DELIVERY_COUNT = 25;
export const BACKLOG_WINDOW_DAYS = 14;

const TEST_NICHES = new Set([
  "x",
  "test",
  "abc",
  "source-readback",
  "internal qa only",
  "internal-validation",
]);

export function isTestRequest({
  request_email: email = "",
  niche = "",
  city = "",
}) {
  const domain = String(email).toLowerCase().split("@")[1] || "";
  const n = String(niche).trim().toLowerCase();
  if (
    !domain ||
    domain.endsWith(".invalid") ||
    /(^|\.)example\.(com|org|net)$/.test(domain)
  )
    return true;
  if (TEST_NICHES.has(n) || n.length < 3 || n.startsWith("re:")) return true;
  return String(city).trim().length < 2;
}

export function isStale(createdAt, now = Date.now()) {
  return now - new Date(createdAt).getTime() > BACKLOG_WINDOW_DAYS * 86400000;
}

export function searchString(niche, city) {
  return `${String(niche).trim()} in ${String(city).trim()}`;
}

function domainOf(url) {
  if (!url) return "";
  try {
    return new URL(
      url.startsWith("http") ? url : `https://${url}`,
    ).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Opportunity score for an SEO agency buyer: weak local presence = more to sell.
// Scored against the local market median so saturated niches still surface real gaps.
export function scorePlace(place, { medianReviews = 50 } = {}) {
  const reasons = [];
  let score = 0;
  const reviews = Number(place.reviewsCount || 0);
  const rating = Number(place.totalScore || 0);
  const median = Math.max(Number(medianReviews) || 0, 20);
  if (!place.website) {
    score += 30;
    reasons.push("no website listed");
  }
  if (reviews < median * 0.25) {
    score += 30;
    reasons.push(
      `${reviews} Google reviews vs a local median of ${Math.round(median)}`,
    );
  } else if (reviews < median * 0.6) {
    score += 18;
    reasons.push(
      `${reviews} Google reviews, below the local median of ${Math.round(median)}`,
    );
  }
  if (rating && rating < 4.3) {
    score += 15;
    reasons.push(`${rating} star rating`);
  }
  if (place.claimThisBusiness) {
    score += 15;
    reasons.push("Google profile unclaimed");
  }
  const rank = Number(place.rank || 0);
  if (rank > 10) {
    score += 12;
    reasons.push(`map position ${rank} for this search`);
  }
  if (place.phone) {
    score += 5;
    reasons.push("phone listed");
  }
  score = Math.min(score, 100);
  const band = score >= 45 ? "high" : score >= 25 ? "usable" : "low";
  return { score, band, reasons };
}

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function placeToLead(place, { runId, niche, city, medianReviews }) {
  const { score, band, reasons } = scorePlace(place, { medianReviews });
  const website = domainOf(place.website);
  const name = String(place.title || "").trim();
  const entity = createHash("sha256")
    .update(
      [
        name.toLowerCase(),
        website || place.phone || "",
        city.toLowerCase(),
      ].join("|"),
    )
    .digest("hex");
  return {
    run_id: runId,
    canonical_entity_id: entity,
    duplicate_group_id: entity,
    business_name: name,
    niche,
    city: place.city
      ? `${place.city}${place.state ? `, ${place.state}` : ""}`
      : city,
    website: website || null,
    phone: place.phone || null,
    source: "google_places",
    source_url: place.url || null,
    collected_at: place.scrapedAt || new Date().toISOString(),
    lead_score: score,
    score_band: band,
    recommended_action:
      band === "high" ? "send_first" : band === "usable" ? "keep" : "hold",
    score_breakdown: {
      reviews: Number(place.reviewsCount || 0),
      rating: Number(place.totalScore || 0),
      map_rank: place.rank ?? null,
    },
    score_reasons: reasons,
  };
}

// National chains and big-box brands are not SEO-agency prospects.
const CHAIN_RE = new RegExp(
  "\\b(" +
    [
      "the home depot",
      "home depot",
      "lowe'?s",
      "walmart",
      "costco",
      "sam'?s club",
      "best buy",
      "ace hardware",
      "true value",
      "menards",
      "sherwin[- ]williams",
      "benjamin moore",
      "roto[- ]rooter",
      "mr\\.? rooter",
      "servpro",
      "stanley steemer",
      "chem[- ]?dry",
      "orkin",
      "terminix",
      "aspen dental",
      "western dental",
      "bright now! dental",
      "heartland dental",
      "smile direct",
      "jiffy lube",
      "valvoline",
      "firestone",
      "goodyear",
      "discount tire",
      "pep boys",
      "autozone",
      "o'?reilly auto",
      "advance auto",
      "midas",
      "meineke",
      "maaco",
      "safelite",
      "h&r block",
      "jackson hewitt",
      "state farm",
      "allstate",
      "farmers insurance",
      "geico",
      "re/?max",
      "keller williams",
      "coldwell banker",
      "century 21",
      "berkshire hathaway",
      "sotheby'?s",
      "anytime fitness",
      "planet fitness",
      "la fitness",
      "orangetheory",
      "great clips",
      "supercuts",
      "sport clips",
      "fantastic sams",
      "petsmart",
      "petco",
      "banfield",
      "vca ",
      "mcdonald'?s",
      "starbucks",
      "subway",
      "chick-fil-a",
      "u-haul",
      "public storage",
      "extra space storage",
      "cubesmart",
      "fedex",
      "ups store",
      "cvs",
      "walgreens",
      "mister car wash",
      "two men and a truck",
      "molly maid",
      "merry maids",
      "mr\\.? handyman",
      "one hour heating",
      "aire serv",
      "window world",
      "renewal by andersen",
      "leaffilter",
      "bath fitter",
      "re-bath",
      "t-mobile",
      "verizon",
      "at&t",
      "xfinity",
    ].join("|") +
    ")\\b",
  "i",
);

export function isChain(place) {
  return CHAIN_RE.test(String(place?.title || ""));
}

export function rankLeads(places, ctx, excludeIds = new Set()) {
  const seen = new Set();
  const open = places.filter(
    (p) => p && p.title && !p.permanentlyClosed && !isChain(p),
  );
  const medianReviews = median(open.map((p) => Number(p.reviewsCount || 0)));
  return open
    .map((p) => placeToLead(p, { ...ctx, medianReviews }))
    .filter((l) => {
      if (
        seen.has(l.canonical_entity_id) ||
        excludeIds.has(l.canonical_entity_id)
      )
        return false;
      seen.add(l.canonical_entity_id);
      return true;
    })
    .sort((a, b) => b.lead_score - a.lead_score);
}

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unsubUrl(email) {
  return `https://tantapulse.com/unsubscribe?email=${encodeURIComponent(email)}`;
}

export function unsubHeaders(email) {
  return {
    "List-Unsubscribe": `<https://tantapulse.com/api/unsubscribe?email=${encodeURIComponent(email)}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

function leadRows(leads) {
  return leads
    .map(
      (l, i) => `
<tr><td style="padding:10px 12px;border-bottom:1px solid #e8e1d2;color:#6b6558;font-size:12px;vertical-align:top">${i + 1}</td>
<td style="padding:10px 12px;border-bottom:1px solid #e8e1d2;vertical-align:top">
<div style="color:#0f2044;font-size:14px;font-weight:700">${esc(l.business_name)}</div>
<div style="color:#6b6558;font-size:12px;margin-top:2px">${esc([l.phone, l.website].filter(Boolean).join(" · ") || "no website or phone listed")}</div>
<div style="color:#7a5518;font-size:12px;margin-top:4px">${esc((l.score_reasons || []).join("; "))}</div></td>
<td style="padding:10px 12px;border-bottom:1px solid #e8e1d2;text-align:right;vertical-align:top;color:#0f2044;font-weight:800">${l.lead_score}</td></tr>`,
    )
    .join("");
}

function shell({ label, body, email }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#fdf9f2;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #ede4d3;border-radius:12px">
<tr><td style="padding:18px 24px;background:#0f2044;border-radius:12px 12px 0 0"><span style="color:#f0c96a;font-size:16px;font-weight:800;letter-spacing:0.08em">TANTA PULSE</span>
<span style="color:#ede4d3;font-size:12px;margin-left:8px">${esc(label)}</span></td></tr>
<tr><td style="padding:24px;color:#3d3d3d;font-size:15px;line-height:1.6">${body}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #ede4d3;color:#6b6558;font-size:12px;line-height:1.6">
Tanta Holdings, 5325 Caprock Ct, Rio Rancho, NM 87144 · <a href="mailto:hello@tantapulse.com" style="color:#7a5518">hello@tantapulse.com</a> ·
<a href="${unsubUrl(email)}" style="color:#7a5518">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>`;
}

function leadTable(leads) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 20px">
<tr><th scope="col" style="text-align:left;padding:6px 12px;color:#6b6558;font-size:11px;text-transform:uppercase">#</th>
<th scope="col" style="text-align:left;padding:6px 12px;color:#6b6558;font-size:11px;text-transform:uppercase">Business and why it scored</th>
<th scope="col" style="text-align:right;padding:6px 12px;color:#6b6558;font-size:11px;text-transform:uppercase">Score</th></tr>${leadRows(leads)}</table>`;
}

export function renderMarketCheck({
  name,
  email,
  niche,
  city,
  leads,
  totalFound,
}) {
  const hi = name ? `Hi ${esc(name.split(" ")[0])},` : "Hi,";
  const high = leads.filter((l) => l.score_band === "high").length;
  const plans = PLANS.map(
    (
      p,
    ) => `<tr><td style="padding:8px 0;border-bottom:1px solid #ede4d3;color:#0f2044;font-weight:700">${p.name} <span style="color:#6b6558;font-weight:400">${p.price}</span></td>
<td align="right" style="padding:8px 0;border-bottom:1px solid #ede4d3"><a href="${p.url}?prefilled_email=${encodeURIComponent(email)}" style="display:inline-block;background:#d6a847;color:#0f2044;font-weight:800;font-size:13px;padding:8px 14px;border-radius:6px;text-decoration:none">Start ${p.name}</a></td></tr>`,
  ).join("");
  const body = `<p style="margin:0 0 12px">${hi}</p>
<p style="margin:0 0 12px">You asked us to check <strong>${esc(niche)}</strong> in <strong>${esc(city)}</strong>. We have coverage. We pulled ${totalFound} businesses from public listings, removed duplicates, and scored each one on how much a local SEO agency has to offer it: missing website, thin reviews, low rating, unclaimed profile, weak map position.</p>
<p style="margin:0 0 4px">Here are the top ${leads.length}${high ? `, ${high} of them high-opportunity` : ""}:</p>
${leadTable(leads)}
<p style="margin:0 0 12px">A plan turns this into a recurring feed for this niche and market, delivered by email each week, with businesses you have already received left out of later deliveries.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${plans}</table>
<p style="margin:16px 0 0">Want a different niche or city checked first? Just reply to this email.</p>`;
  return {
    subject: `Market check: ${niche} in ${city} (${leads.length} scored leads inside)`,
    html: shell({ label: "Market check", body, email }),
  };
}

export function renderPaidDelivery({ name, email, niche, city, leads, tier }) {
  const hi = name ? `Hi ${esc(name.split(" ")[0])},` : "Hi,";
  const body = `<p style="margin:0 0 12px">${hi}</p>
<p style="margin:0 0 12px">Here is this week's Tanta Pulse feed for <strong>${esc(niche)}</strong> in <strong>${esc(city)}</strong>: ${leads.length} businesses, deduped against everything we have sent you before and ranked by opportunity score.</p>
${leadTable(leads)}
<p style="margin:0">Want to change the niche or market, or add another? Reply to this email.${tier === "agency" ? " You have a direct line to our team on this thread." : ""}</p>`;
  return {
    subject: `Your Tanta Pulse feed: ${leads.length} ${niche} leads in ${city}`,
    html: shell({ label: "Weekly feed", body, email }),
  };
}

export function renderOnboarding({ name, email, tier, niche, city }) {
  const hi = name ? `Hi ${esc(name.split(" ")[0])},` : "Hi,";
  const plan = PLANS.find((p) => p.tier === tier)?.name || "Tanta Pulse";
  const next =
    niche && city
      ? `<p style="margin:0 0 12px">Your feed is set to <strong>${esc(niche)}</strong> in <strong>${esc(city)}</strong>, from your market check. Your first delivery is being built now and will arrive by email shortly, then weekly after that.</p>`
      : `<p style="margin:0 0 12px"><strong>One thing we need:</strong> reply to this email with the niche and city you sell into (for example, "roofers in Austin, TX"). Your first delivery goes out as soon as we have it, then weekly after that.</p>`;
  const body = `<p style="margin:0 0 12px">${hi}</p>
<p style="margin:0 0 12px">You're subscribed to Tanta Pulse ${esc(plan)}. Thank you.</p>
${next}
<p style="margin:0">Questions, changes, or more markets: reply here and it reaches our team.</p>`;
  return {
    subject: `Welcome to Tanta Pulse ${plan}`,
    html: shell({ label: "Welcome", body, email }),
  };
}

export const OUTREACH_FROM = "Jon Edwards <hello@tantapulse.com>";
export const OUTREACH_REPLY_TO = MONITORED_INBOX;
export const OUTREACH_DAILY_CAP = 20;
export const OUTREACH_PASS_CAP = 5;
// Leads discovered after the SEO retarget; earlier `apify` leads are roofers.
export const SEO_DISCOVERY_CUTOVER = "2026-09-26T12:40:00Z";
export const MARKET_CHECK_URL =
  "https://tantapulse.com/?utm_source=outbound&utm_medium=email&utm_campaign=seo_market_check#request";

// Weekdays 9am-5pm US Central (14:00-22:00 UTC).
export function inOutreachWindow(date = new Date()) {
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  return day >= 1 && day <= 5 && hour >= 14 && hour < 22;
}

export function renderOutreach({ company, email }) {
  const who = company ? esc(company) : "your team";
  const body = `<p style="margin:0 0 12px">Hi ${who},</p>
<p style="margin:0 0 12px">I run Tanta Pulse. We pull local businesses from public Google listings for any niche and city, then score each one on how much an SEO agency could do for it: no website, thin reviews next to local competitors, an unclaimed profile, a buried map position.</p>
<p style="margin:0 0 12px">Tell us one niche and city you sell into and we will send back the top 10 of those businesses within minutes, free, with the reason each one scored. No call and no card.</p>
<p style="margin:0 0 16px"><a href="${MARKET_CHECK_URL}" style="display:inline-block;background:#d6a847;color:#0f2044;font-weight:800;padding:10px 16px;border-radius:6px;text-decoration:none">Get your market check</a></p>
<p style="margin:0 0 12px">If it is useful, a weekly feed starts at $49/month. If not, this is the only note you will get from us.</p>
<p style="margin:0">Jon Edwards<br>Tanta Pulse, a Tanta Holdings company</p>`;
  return {
    subject: `Free market check for ${company || "your agency"}'s clients`,
    html: shell({ label: "Market check offer", body, email }),
  };
}

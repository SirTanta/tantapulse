/**
 * Owner first-name capture for cold outreach. Precision over recall: a wrongly guessed
 * name does more harm than a company greeting, so every function here returns a rejection
 * unless the evidence is explicit. No LLM, no inference from email addresses alone, no paid
 * sources.
 *
 * Sources, in order:
 *   1. Hunter Domain Search person data for the chosen email (position + local-part check)
 *   2. A plain HTTP fetch of the business's own About/Team/Contact page, extracting a name
 *      explicitly labelled owner/founder/CEO/president via fixed patterns.
 */

// Position strings (Hunter). Vice/assistant/etc. never count; co-owner is ambiguous (two owners).
const OWNER_POSITION_RE =
  /\b(owner|founder|co-?founder|ceo|chief executive( officer)?|president|principal|managing partner)\b/i;
const POSITION_DISQUALIFIER_RE =
  /\b(vice|vp|assistant|associate|former|ex-|co-?owner|account|sales|marketing|operations|client|customer|office|general manager|art|creative|technical|chief (?!executive))\b/i;

const ROLE_LOCALS = new Set([
  "info", "sales", "hello", "hi", "contact", "admin", "office", "support", "team", "mail",
  "marketing", "service", "services", "help", "enquiries", "inquiries", "enquiry", "inquiry",
  "billing", "accounts", "accounting", "hr", "jobs", "careers", "press", "media", "webmaster",
  "noreply", "no-reply", "reception", "booking", "bookings", "orders", "general", "business",
  "owner", "ceo", "president", "founder", "manager", "studio", "agency", "web", "seo",
]);

// Tokens that can never be a person's first name (page furniture, business words, titles).
const NON_NAME_TOKENS = new Set(
  (
    "the our meet contact about team staff owner owners founder cofounder ceo president principal partner partners " +
    "managing director manager chief executive officer vice assistant digital marketing media agency group solutions " +
    "studio studios design web seo consulting services service company co inc llc ltd corp austin texas local online " +
    "creative social search engine optimization optimisation growth brand branding click clicks leads lead hello hi " +
    "welcome home info admin sales support presented founded owned started run and or with by for from at in of to is " +
    "we i my us your you mr mrs ms dr miss email call phone address read more get free new full premier best top pro " +
    "professional expert experts tx usa north south east west city county state national american general business " +
    "businesses client clients customer customers unknown test na none null undefined anonymous name story mission " +
    "bio details since page operated operator operators operations operation family locally licensed certified " +
    "insured proud member award winning awarded years year experience quality trusted reliable affordable custom " +
    "residential commercial industrial landscaping plumbing roofing heating cooling air electric electrical " +
    "construction remodeling painting cleaning pest control law legal dental medical health care wellness fitness " +
    "real estate realty insurance financial tax accounting auto automotive repair restaurant cafe coffee bar grill " +
    "salon spa beauty barber pet vet animal hospital clinic center centre school academy institute foundation " +
    "association society club church ministry network systems technologies technology tech labs lab software " +
    "development developers developer engineering engineers photography video production productions films " +
    "events event wedding weddings travel tours tour transport transportation logistics moving storage products " +
    "supply supplies equipment rental rentals sales retail wholesale outlet store shop market markets mart " +
    "mission vision values culture careers join apply blog news press gallery portfolio work works projects " +
    "testimonials reviews faq faqs pricing plans plan shipping returns policy privacy terms copyright rights " +
    "reserved all by designed powered built hosted love thank thanks please click here view see learn today " +
    "now online offline open closed hours monday tuesday wednesday thursday friday saturday sunday " +
    "january february march april may june july august september october november december " +
    "are was were be been being has have had does did not no yes " +
    "she he they it this that her his their who what when where why how strategy strategist wealth broker"
  ).split(/\s+/),
);

export function normalizeAlnum(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Sanitize a candidate first name. Letters (incl. accented), hyphen, apostrophe only.
 * Returns a title-cased string or null. All-caps input is junk and rejected; so are
 * non-name tokens and anything under 2 letters.
 */
export function sanitizeFirstName(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/[‘’ʼ]/g, "'");
  if (!/^[\p{L}][\p{L}'-]*[\p{L}]$/u.test(s)) return null;
  const letters = s.replace(/[^\p{L}]/gu, "");
  if (letters.length < 2 || letters.length > 20) return null;
  if (/--|''|-'|'-/.test(s)) return null;
  if (s === s.toUpperCase()) return null; // ALL CAPS junk
  if (NON_NAME_TOKENS.has(s.toLowerCase())) return null;
  return s
    .toLowerCase()
    .split("-")
    .map((part) =>
      part
        .split("'")
        .map((p) => (p ? p[0].toLocaleUpperCase() + p.slice(1) : p))
        .join("'"),
    )
    .join("-");
}

export function isRoleMailbox(email) {
  const local = String(email || "").split("@")[0].toLowerCase();
  if (!local) return true;
  const base = local.replace(/[^a-z]/g, "");
  return ROLE_LOCALS.has(local) || ROLE_LOCALS.has(base);
}

/** True when the name is (or is the whole of) the business name, e.g. a one-word brand. */
export function nameMatchesBusiness(first, last, business) {
  const b = normalizeAlnum(business);
  const f = normalizeAlnum(first);
  if (!f || !b) return false;
  if (b === f) return true;
  const full = normalizeAlnum(`${first || ""}${last || ""}`);
  if (full && b === full) return true;
  const words = String(business || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 1 && words[0] === f) return true;
  return false;
}

/** Email local part consistent with the person: jane@, jane.doe@, jdoe@, janed@, jane_doe@, doe.jane@ */
export function localPartConsistent(local, first, last) {
  const l = normalizeAlnum(local);
  const f = normalizeAlnum(first);
  const s = normalizeAlnum(last);
  if (!l || !f) return false;
  if (l === f) return true;
  if (!s) return false;
  return new Set([f + s, s + f, f[0] + s, f + s[0], s + f[0], s[0] + f]).has(l);
}

function positionIsOwner(position) {
  const p = String(position || "");
  return OWNER_POSITION_RE.test(p) && !POSITION_DISQUALIFIER_RE.test(p);
}

/**
 * Decide whether Hunter's own person data for `email` supports a high-confidence owner name.
 * `hunterData` is the Domain Search `data` object (used only to detect conflicting owners).
 * Returns { ok:true, first_name, source:"hunter", confidence:"high", reason } or { ok:false, reason }.
 */
export function ownerFromHunter(email, hunterData, business) {
  if (!email?.value) return { ok: false, reason: "no_email" };
  if (isRoleMailbox(email.value)) return { ok: false, reason: "role_mailbox" };
  if (String(email.type || "").toLowerCase() === "generic")
    return { ok: false, reason: "generic_email" };
  if (!email.first_name) return { ok: false, reason: "no_person_name" };
  if (!positionIsOwner(email.position || email.position_raw))
    return { ok: false, reason: "position_not_owner" };
  const first = sanitizeFirstName(email.first_name);
  if (!first) return { ok: false, reason: "name_invalid" };
  if (nameMatchesBusiness(first, email.last_name, business))
    return { ok: false, reason: "name_equals_business" };
  const local = String(email.value).split("@")[0];
  const consistent = localPartConsistent(local, first, email.last_name);
  if (!consistent && !(Number(email.confidence || 0) >= 90))
    return { ok: false, reason: "local_part_mismatch_and_confidence_below_90" };

  // Another email on the same domain carrying an owner-type position with a different first
  // name means we cannot tell who the owner is.
  const others = Array.isArray(hunterData?.emails) ? hunterData.emails : [];
  for (const o of others) {
    if (!o || o.value === email.value || !o.first_name) continue;
    if (positionIsOwner(o.position || o.position_raw)) {
      const of = sanitizeFirstName(o.first_name);
      if (of && of !== first) return { ok: false, reason: "multiple_owner_candidates" };
    }
  }
  return {
    ok: true,
    first_name: first,
    source: "hunter",
    confidence: "high",
    reason: `Hunter position "${email.position || email.position_raw}", ${consistent ? "email local part matches name" : `Hunter confidence ${email.confidence}`}`,
  };
}

// ---------------------------------------------------------------------------------------
// Website extraction
// ---------------------------------------------------------------------------------------

function ciWord(w) {
  return w
    .split("")
    .map((c) => {
      if (/[a-z]/i.test(c)) return `[${c.toLowerCase()}${c.toUpperCase()}]`;
      if (c === " ") return "\\s+";
      if (c === "-") return "[-\\s]?";
      return c;
    })
    .join("");
}
const TITLES = ["co-founder", "founder", "owner", "ceo", "chief executive officer", "president", "principal", "managing partner"];
const TITLE_SRC = `(?:${TITLES.map(ciWord).join("|")})`;
const TITLE_RE = new RegExp(TITLE_SRC);
const NAME_TOKEN = "[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?";
// Optional honorific, first name, optional middle initial, 0-2 more name tokens.
const NAME_SRC = `(?:(?:Dr|Mr|Mrs|Ms)\\.?\\s+)?(${NAME_TOKEN}(?:\\s+[A-Z]\\.)?(?:\\s+${NAME_TOKEN}){0,2})`;
const SEP = "\\s*(?:,|\\||-|\\u2013|\\u2014|:|\\u00b7)\\s*";

const PATTERNS = [
  // Jane Doe, Owner / Jane Doe | Founder & CEO / Jane Doe - President
  new RegExp(`${NAME_SRC}${SEP}${TITLE_SRC}(?![A-Za-z])`, "g"),
  // Owner: Jane Doe / Founder - Jane Doe / Owner | Jane Doe
  new RegExp(`${TITLE_SRC}${SEP}${NAME_SRC}`, "g"),
  // Founder & CEO: Jane Doe
  new RegExp(`${TITLE_SRC}\\s*(?:&|and)\\s*${TITLE_SRC}${SEP}${NAME_SRC}`, "g"),
  // Founded|Owned|Started|Run|Led by Jane Doe
  new RegExp(`(?:[Ff]ounded|[Oo]wned(?:\\s+and\\s+operated)?|[Ss]tarted|[Ll]ed|[Rr]un)\\s+by\\s+${NAME_SRC}`, "g"),
  // Jane Doe is the owner / Jane Doe, our founder
  new RegExp(`${NAME_SRC}\\s+(?:is|serves\\s+as)\\s+(?:the\\s+|our\\s+|a\\s+)?(?:[a-z-]+\\s+)?${TITLE_SRC}(?![A-Za-z])`, "g"),
  new RegExp(`${NAME_SRC}\\s*,\\s+(?:our|the)\\s+(?:[a-z-]+\\s+)?${TITLE_SRC}(?![A-Za-z])`, "g"),
  // I'm Jane Doe, the owner / My name is Jane Doe and I am the founder
  new RegExp(`(?:I'm|I\\u2019m|I\\s+am|[Mm]y\\s+name\\s+is)\\s+${NAME_SRC}\\s*(?:,|and\\s+I(?:'m|\\s+am)?)\\s*(?:the\\s+|a\\s+|an\\s+)?(?:[a-z-]+\\s+)?${TITLE_SRC}(?![A-Za-z])`, "g"),
];

export function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?(?:p|div|li|ul|ol|br|h[1-6]|section|article|td|tr|th|figcaption|header|footer|nav|button|label)\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;|&#x2019;|&#39;|&apos;/g, "'")
    .replace(/&#8211;|&ndash;|&#8212;|&mdash;/g, "-")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A title preceded by vice/assistant/former/co-owner is not a clean single-owner label.
function badTitleContext(text, matchIndex, matchStr) {
  const t = matchStr.match(TITLE_RE);
  if (!t) return false;
  // every title occurrence inside the match: check its immediate left context
  const re = new RegExp(TITLE_SRC, "g");
  let m;
  while ((m = re.exec(matchStr))) {
    const abs = matchIndex + m.index;
    const before = text.slice(Math.max(0, abs - 12), abs).toLowerCase();
    if (/(vice|assistant|associate|former|ex)[-\s]$/.test(before)) return true;
    if (/owner/i.test(m[0]) && /co[-\s]?$/.test(before)) return true;
  }
  return false;
}

// Patterns that may legitimately carry a first name only (the sentence itself says who the owner is).
const SINGLE_NAME_OK = new Set([4, 6]); // "X is the owner" and "I'm X, the owner"
const AFTER_TITLE_ORG_RE = /^\s*(?:(?:&|and|\/)\s*TITLE\s*)?(?:(?:of|at|for|@)\s|[,|]\s*[A-Z][A-Za-z]|[-–—]\s*[A-Z][A-Za-z])/.source;
const AFTER_RE = new RegExp(AFTER_TITLE_ORG_RE.replace("TITLE", TITLE_SRC));
const QUOTE_BEFORE_RE = /["”“»]\s*[-–—]*\s*$/;

/** Extract owner-labelled names from page text. Returns distinct [{first, last, full, evidence}]. */
export function extractOwnerNames(text, business) {
  const found = new Map();
  PATTERNS.forEach((re, idx) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (badTitleContext(text, m.index, m[0])) continue;
      const nameStart = m.index + m[0].indexOf(m[1]);
      const nameEnd = nameStart + m[1].length;
      // Testimonials: a name right after a closing quote, or a title followed by another
      // organisation ("Jane Doe, Owner, Acme Roofing" / "Owner of Acme"), is a client, not us.
      if (QUOTE_BEFORE_RE.test(text.slice(Math.max(0, nameStart - 8), nameStart))) continue;
      const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
      const afterRegion = idx === 1 || idx === 2 || idx === 3 ? text.slice(nameEnd, nameEnd + 40) : tail;
      if (AFTER_RE.test(afterRegion)) continue;
      const parts = String(m[1] || "")
        .replace(/\./g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1); // drop middle initials
      while (parts.length && sanitizeFirstName(parts[0]) === null && NON_NAME_TOKENS.has(parts[0].toLowerCase())) parts.shift();
      while (parts.length > 1 && NON_NAME_TOKENS.has(parts[parts.length - 1].toLowerCase())) parts.pop();
      if (!parts.length || parts.length > 3) continue;
      if (parts.length < 2 && !SINGLE_NAME_OK.has(idx)) continue; // title-adjacent single words are too ambiguous
      const first = sanitizeFirstName(parts[0]);
      if (!first) continue;
      if (parts.slice(1).some((t) => NON_NAME_TOKENS.has(t.toLowerCase()))) continue;
      const last = parts.length > 1 ? parts[parts.length - 1] : "";
      if (nameMatchesBusiness(first, last, business)) continue;
      if (normalizeAlnum(parts.join("")) === normalizeAlnum(business)) continue; // the whole name is the business name
      // a first name that is just a word of the business name ("Salterra", "Webb") is a brand
      if (!last && normalizeAlnum(business).includes(normalizeAlnum(first))) continue;
      const full = `${first} ${last}`.trim().toLowerCase();
      if (!found.has(full)) found.set(full, { first, last, full, evidence: m[0].slice(0, 120) });
    }
  });
  return [...found.values()];
}

/** Choose a single, unambiguous owner name from the candidates found across pages. */
export function pickOwner(names) {
  if (!names.length) return { ok: false, reason: "no_labelled_owner" };
  // "Jane" and "Jane Doe" are the same person: collapse by first name keeping the fuller form.
  const byFirst = new Map();
  for (const n of names) {
    const k = n.first.toLowerCase();
    const cur = byFirst.get(k);
    if (!cur || (!cur.last && n.last)) byFirst.set(k, n);
  }
  const distinct = [...byFirst.values()];
  if (distinct.length > 1) return { ok: false, reason: "multiple_owner_candidates" };
  return { ok: true, first_name: distinct[0].first, full: distinct[0].full, evidence: distinct[0].evidence };
}

// robots.txt: honour Allow/Disallow for our own agent token, else "*".
export function robotsAllows(robotsTxt, path, agentToken = "tantapulsebot") {
  if (!robotsTxt) return true;
  const groups = [];
  let cur = null;
  for (const raw of String(robotsTxt).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!cur || cur.rules.length) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
    } else if ((key === "disallow" || key === "allow") && cur) {
      cur.rules.push({ allow: key === "allow", path: val });
    }
  }
  const specific = groups.filter((g) => g.agents.includes(agentToken));
  const applicable = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  let best = null;
  for (const g of applicable) {
    for (const r of g.rules) {
      if (r.path === "") continue;
      const pat = r.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*").replace(/\\\$$/, "$");
      if (new RegExp(`^${pat}`).test(path)) {
        if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))
          best = r;
      }
    }
  }
  return best ? best.allow : true;
}

const UA = "Mozilla/5.0 (compatible; TantaPulseBot/1.0; +https://tantapulse.com)";
const ABOUT_KEYS = ["about", "team", "our-story", "meet", "who-we-are", "leadership", "contact"];

async function politeGet(fetchImpl, url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const ct = String(res.headers?.get?.("content-type") || "");
    if (ct && !/text\/|application\/xhtml/i.test(ct)) return null;
    const body = await res.text();
    return { body: body.slice(0, 600000), finalUrl: res.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function sameSite(host, domain) {
  const h = String(host).replace(/^www\./, "").toLowerCase();
  return h === domain || h.endsWith(`.${domain}`);
}

/**
 * Polite same-domain fetch: robots.txt, the homepage (to find the About/Team link), then at most
 * one About/Team/Contact page. Max 3 requests, short timeout, no JS rendering.
 * Returns { ok:true, first_name, full, source:"website", confidence:"high", url, reason } or { ok:false, reason }.
 */
export async function ownerFromWebsite(domain, business, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  domain = String(domain || "").toLowerCase();
  if (!domain) return { ok: false, reason: "no_domain" };
  const base = `https://${domain}`;
  const robots = await politeGet(fetchImpl, `${base}/robots.txt`, timeoutMs);
  const robotsTxt = robots?.body && !/<html/i.test(robots.body) ? robots.body : "";
  const allowed = (p) => robotsAllows(robotsTxt, p);
  if (!allowed("/")) return { ok: false, reason: "robots_disallow" };
  const home = await politeGet(fetchImpl, `${base}/`, timeoutMs);
  if (!home) return { ok: false, reason: "fetch_failed" };
  let homeHost;
  try { homeHost = new URL(home.finalUrl).hostname; } catch { return { ok: false, reason: "fetch_failed" }; }
  if (!sameSite(homeHost, domain)) return { ok: false, reason: "redirected_off_domain" };
  const pages = [{ url: home.finalUrl, body: home.body }];

  const links = [];
  const linkRe = /href\s*=\s*["']([^"'#?]+)["']/gi;
  let m;
  while ((m = linkRe.exec(home.body))) links.push(m[1]);
  let aboutUrl = null;
  for (const key of ABOUT_KEYS) {
    for (const l of links) {
      if (!l.toLowerCase().includes(key)) continue;
      try {
        const u = new URL(l, home.finalUrl);
        const segs = u.pathname.split("/").filter(Boolean);
        const junk = /(blog|news|video|post|article|categor|tag|20\d\d|podcast|case-stud|portfolio|work)/i.test(u.pathname);
        if (sameSite(u.hostname, domain) && segs.length >= 1 && segs.length <= 2 && !junk && /^https?:$/.test(u.protocol)) {
          aboutUrl = u;
          break;
        }
      } catch { /* ignore */ }
    }
    if (aboutUrl) break;
  }
  if (!aboutUrl) {
    try { aboutUrl = new URL("/about", home.finalUrl); } catch { /* ignore */ }
  }
  if (aboutUrl && allowed(aboutUrl.pathname)) {
    const page = await politeGet(fetchImpl, aboutUrl.toString(), timeoutMs);
    if (page) {
      try {
        if (sameSite(new URL(page.finalUrl).hostname, domain)) pages.push({ url: page.finalUrl, body: page.body });
      } catch { /* ignore */ }
    }
  }
  const names = [];
  let src = null;
  for (const p of pages) {
    const found = extractOwnerNames(htmlToText(p.body), business);
    if (found.length && !src) src = p.url;
    names.push(...found);
  }
  const pick = pickOwner(names);
  if (!pick.ok) return { ok: false, reason: pick.reason };
  return {
    ok: true,
    first_name: pick.first_name,
    full: pick.full,
    source: "website",
    confidence: "high",
    url: src || base,
    evidence: pick.evidence,
    reason: `website labels "${pick.full}" as owner/founder/CEO/president at ${src || base}`,
  };
}

/**
 * Greeting "Hi Jim," on jessica@company.com is wrong even if Jim really is the owner. A
 * website-sourced name is only used when the mailbox is a role mailbox (info@, hello@) or the
 * local part / Hunter person name matches the owner. Anything else keeps the company greeting.
 */
export function mailboxAllowsOwner(email, ownerFirst) {
  if (!email?.value) return { ok: false, reason: "no_email" };
  const local = String(email.value).split("@")[0];
  const hf = email.first_name ? sanitizeFirstName(email.first_name) : null;
  if (hf) {
    return hf.toLowerCase() === ownerFirst.toLowerCase()
      ? { ok: true }
      : { ok: false, reason: "mailbox_belongs_to_other_person" };
  }
  if (isRoleMailbox(email.value)) return { ok: true };
  if (normalizeAlnum(local).startsWith(normalizeAlnum(ownerFirst))) return { ok: true };
  return { ok: false, reason: "mailbox_unverified_person" };
}

/** Hunter first, then website. Never throws. */
export async function resolveOwnerName({ email, hunterData, business, domain, fetchImpl, timeoutMs, allowWebsite = true }) {
  const h = ownerFromHunter(email, hunterData, business);
  if (h.ok) return h;
  if (!allowWebsite) return { ok: false, reason: h.reason };
  try {
    const w = await ownerFromWebsite(domain, business, { fetchImpl, timeoutMs });
    if (!w.ok) return { ok: false, reason: `hunter:${h.reason}; website:${w.reason}` };
    const mb = mailboxAllowsOwner(email, w.first_name);
    if (!mb.ok) return { ok: false, reason: `hunter:${h.reason}; website:${mb.reason}` };
    return w;
  } catch {
    return { ok: false, reason: `hunter:${h.reason}; website:error` };
  }
}

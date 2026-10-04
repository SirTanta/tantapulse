import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Jon decision 2026-10-05: the free market check is paused (Google Maps Platform
// terms). Every public page must show the notice and no data-collection form.
const pages = [
  "index.html",
  "pricing.html",
  "austin-seo-agency-leads.html",
  "local-seo-agency-leads.html",
  "hvac-leads.html",
  "roofing-leads.html",
];

for (const page of pages) {
  const html = await readFile(new URL(`../public/${page}`, import.meta.url), "utf8");
  assert.doesNotMatch(html, /<form\b/i, `${page}: no form`);
  assert.doesNotMatch(html, /<input\b|<textarea\b/i, `${page}: no inputs`);
  assert.doesNotMatch(html, /sample-form|\/api\/sample-request/, `${page}: no sample-request wiring`);
  assert.match(html, /temporarily unavailable while we move to a new data source/, `${page}: notice present`);
  assert.match(html, /mailto:hello@tantapulse\.com/, `${page}: mailto present`);
  assert.doesNotMatch(html, /Get my free[^<]*market check|Check my market|Send my market|Request your free market check/, `${page}: no market-check CTA`);
  // Keep SEO and analytics tags intact.
  assert.match(html, /<title>[^<]+<\/title>/, `${page}: title`);
  assert.match(html, /<link rel="canonical" href="https:\/\/tantapulse\.com/, `${page}: canonical`);
  assert.match(html, /og-card\.png/, `${page}: og image`);
  assert.match(html, /_vercel\/insights\/script\.js/, `${page}: analytics script`);
}

// Jon decision 2026-10-05 (follow-up): paid plans are paused too. The three Stripe
// payment links are deactivated; no page may link to buy.stripe.com or claim a
// Google/Maps data source.
const visible = (html) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
const bannedSource = [
  /buy\.stripe\.com/i,
  /plink_/i,
  /Google listing/i,
  /public map/i,
  /Map position/i,
  /Unclaimed Google/i,
  /Google (profile|reviews|Maps)/i,
  /\bmap results\b|\bmap listings\b|\bpublic listing/i,
  /\bGoogle Places\b/i,
  /Subscribe\s*(—|-|&mdash;)/i,
  /See plans from/i,
];
for (const page of pages) {
  const html = await readFile(new URL(`../public/${page}`, import.meta.url), "utf8");
  const text = visible(html);
  for (const re of bannedSource) {
    assert.doesNotMatch(html.replace(/<link[^>]*fonts\.googleapis[^>]*>/g, ""), re, `${page}: banned ${re}`);
  }
  assert.doesNotMatch(text, /\blisting/i, `${page}: no listing-source wording`);
  assert.match(
    text,
    /(Paid plans|plans) (are|and the free market check are) temporarily unavailable while we move to a new data source|Paid plans (are )?paused/i,
    `${page}: paid plans paused notice`,
  );
}
const pricing = await readFile(new URL("../public/pricing.html", import.meta.url), "utf8");
assert.match(pricing, /Paid plans are temporarily unavailable while we move to a new data source/, "pricing: plans notice");
assert.equal((pricing.match(/Paused/g) || []).length >= 4, true, "pricing: every plan card labeled Paused");

console.log("market-check-paused: PASS");

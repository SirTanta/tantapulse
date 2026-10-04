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

// Paid plan links stay untouched.
const pricing = await readFile(new URL("../public/pricing.html", import.meta.url), "utf8");
for (const id of ["aFa00c74H8i0ghZ12j5J605", "4gMdR274HeGo5Dl3ar5J606", "aFadR2cp1bucghZfXd5J607"]) {
  assert.ok(pricing.includes(`https://buy.stripe.com/${id}`), `stripe link ${id} intact`);
}

console.log("market-check-paused: PASS");

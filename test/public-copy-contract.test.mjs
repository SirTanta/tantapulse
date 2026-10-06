import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pages = ["index.html", "pricing.html"];

// Launch copy may sell the product. It may not invent social proof, guarantee
// outcomes, or quote performance numbers we cannot substantiate.
const forbiddenClaims = [
  /free\s+sample/i,
  /guarantee(d|s)?\b/i,
  /risk[-\s]free/i,
  /money[-\s]back/i,
  /no[-\s]questions[-\s]asked/i,
  /\d+\s*%\s*(more|increase|lift|conversion|close)/i,
  /\d+\s*x\s+(roi|return|more\s+leads)/i,
  /\btrusted\s+by\b/i,
  /\bas\s+seen\s+(in|on)\b/i,
  /\b\d[\d,]*\+?\s+(agencies|customers|clients|users)\s+(use|trust|rely)/i,
  /\btestimonial/i,
  /\bcase\s+stud(y|ies)\b/i,
];

function visibleText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

for (const page of pages) {
  const [source, deployed] = await Promise.all([
    readFile(new URL(`../${page}`, import.meta.url), "utf8"),
    readFile(new URL(`../public/${page}`, import.meta.url), "utf8"),
  ]);
  assert.equal(source, deployed, `${page} source must match deployed public artifact`);
  const text = visibleText(source);
  for (const pattern of forbiddenClaims) {
    assert.doesNotMatch(text, pattern, `${page} must not contain unsubstantiated claim ${pattern}`);
  }
  assert.match(text, /austin/i, `${page} must keep the Austin local-SEO positioning`);
  assert.match(text, /hello@tantapulse\.com/i, `${page} must expose a contact address`);
}

const pricing = await readFile(new URL("../pricing.html", import.meta.url), "utf8");
assert.doesNotMatch(pricing, /buy\.stripe\.com|plink_/, "paid plans paused: no payment-link URLs");
assert.match(pricing, /\$49[\s\S]*?\$149[\s\S]*?\$399/, "pricing keeps the plan prices visible, labeled paused");
assert.match(pricing, /Paused/, "pricing labels plans Paused");
const publicPricing = await readFile(new URL("../public/pricing.html", import.meta.url), "utf8");
for (const [name, html] of [["pricing.html", pricing], ["public/pricing.html", publicPricing]]) {
  assert.match(html, /45 or higher is banded high, 25 to 44 is usable, and below 25 is low/, `${name} FAQ must state the real score bands (scorePlace: 45/25)`);
  assert.doesNotMatch(html, /Above 80|50 to 80/, `${name} must not state the retired 80/50 bands`);
  assert.doesNotMatch(html, /unclaimed Google|map position|Google reviews|public local business listing/i, `${name} must not claim Maps-sourced signals`);
}
for (const page of pages) {
  const html = await readFile(new URL(`../${page}`, import.meta.url), "utf8");
  assert.doesNotMatch(html, /fit, intent, quality, and engagement/, `${page} must not describe the retired scoring model`);
}
console.log("public-copy-contract: PASS (launch copy; no fabricated proof; source/public parity; plans paused)");

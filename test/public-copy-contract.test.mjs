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
const expectedLinks = {
  Starter: "https://buy.stripe.com/aFa00c74H8i0ghZ12j5J605",
  Pro: "https://buy.stripe.com/4gMdR274HeGo5Dl3ar5J606",
  Agency: "https://buy.stripe.com/aFadR2cp1bucghZfXd5J607",
};
for (const [tier, link] of Object.entries(expectedLinks)) {
  assert.match(pricing, new RegExp(`>${tier}</div>[\\s\\S]*?href="${link}"`), `${tier} must preserve its PR #12 checkout link`);
}
assert.match(pricing, /\$49[\s\S]*?\$149[\s\S]*?\$399/, "pricing must show matched $49/$149/$399 plan prices");
console.log("public-copy-contract: PASS (launch copy; no fabricated proof; source/public parity; PR #12 pricing links)");

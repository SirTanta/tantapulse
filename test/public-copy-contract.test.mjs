import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pages = ["index.html", "pricing.html"];
const forbiddenClaims = [
  /request\s+(a\s+)?sample/i,
  /free\s+sample/i,
  /one-time\s+email\s+delivery/i,
  /fresh\s+local\s+leads,?\s+ranked\s+and\s+delivered\s+weekly/i,
  /fresh\s+feed\s+cadence/i,
  /weekly\s+lead\s+feed/i,
  /email\s+delivery\s+every/i,
  /follow-up\s+sequence/i,
  /automatically/i,
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
    assert.doesNotMatch(text, pattern, `${page} must not contain forbidden public claim ${pattern}`);
  }
  assert.match(text, /internal review/i, `${page} must state the internal-review-only posture`);
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
console.log("public-copy-contract: PASS (internal-review-only copy; source/public parity; PR #12 pricing links)");

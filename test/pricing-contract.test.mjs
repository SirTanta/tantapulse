import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const expectedLinks = {
  Starter: "https://buy.stripe.com/aFa00c74H8i0ghZ12j5J605",
  Pro: "https://buy.stripe.com/4gMdR274HeGo5Dl3ar5J606",
  Agency: "https://buy.stripe.com/aFadR2cp1bucghZfXd5J607",
};

const [sourcePricing, deployedPricing] = await Promise.all([
  readFile(new URL("../pricing.html", import.meta.url), "utf8"),
  readFile(new URL("../public/pricing.html", import.meta.url), "utf8"),
]);

assert.equal(sourcePricing, deployedPricing, "source pricing must match the deployed public artifact");
assert.doesNotMatch(sourcePricing, /\$97|9700|Growth — Coming Soon/i, "legacy $97/Growth checkout copy must not be published");

for (const [tier, link] of Object.entries(expectedLinks)) {
  assert.match(sourcePricing, new RegExp(`>${tier}</div>[\\s\\S]*?href="${link}"`), `${tier} must use its canonical Stripe Payment Link`);
}

console.log("pricing-contract: PASS (source/public parity; canonical $49/$149/$399 links; no legacy $97)");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [sourcePricing, deployedPricing] = await Promise.all([
  readFile(new URL("../pricing.html", import.meta.url), "utf8"),
  readFile(new URL("../public/pricing.html", import.meta.url), "utf8"),
]);

assert.equal(sourcePricing, deployedPricing, "source pricing must match the deployed public artifact");
assert.doesNotMatch(sourcePricing, /\$97|9700|Growth — Coming Soon/i, "legacy $97/Growth checkout copy must not be published");

assert.doesNotMatch(sourcePricing, /buy\.stripe\.com|plink_/, "paid plans are paused: no payment-link URLs on /pricing");
assert.doesNotMatch(sourcePricing, /<a[^>]*>\s*Subscribe/i, "no Subscribe buttons while plans are paused");
for (const tier of ["Starter", "Pro", "Agency"]) {
  assert.match(sourcePricing, new RegExp(`badge-${tier.toLowerCase()}">${tier} &middot; Paused`), `${tier} card must be labeled Paused`);
}
assert.match(sourcePricing, /temporarily unavailable while we move to a new data source/, "paused notice present");
assert.match(sourcePricing, /mailto:hello@tantapulse\.com/, "email-only contact present");

console.log("pricing-contract: PASS (source/public parity; plans paused, no payment links; no legacy $97)");

import test from "node:test";
import assert from "node:assert/strict";
import { renderUpsellHtml } from "../api/lead-feed/deliver-sample.js";

test("sample-delivery upsell renders every Stripe plan with an actionable checkout link", () => {
  const html = renderUpsellHtml({ name: "Jordan" });

  assert.match(html, /Jordan/);
  assert.match(html, /Starter/);
  assert.match(html, /\$49\/mo/);
  assert.match(html, /https:\/\/buy\.stripe\.com\/aFa00c74H8i0ghZ12j5J605/);
  assert.match(html, /Pro/);
  assert.match(html, /\$149\/mo/);
  assert.match(html, /https:\/\/buy\.stripe\.com\/4gMdR274HeGo5Dl3ar5J606/);
  assert.match(html, /Agency/);
  assert.match(html, /\$399\/mo/);
  assert.match(html, /https:\/\/buy\.stripe\.com\/aFadR2cp1bucghZfXd5J607/);
});

import assert from "node:assert/strict";

process.env.STRIPE_SECRET_KEY = "unit-test-key";
let captured = null;
globalThis.fetch = async (url, options) => {
  captured = { url, options };
  return new Response(
    JSON.stringify({ id: "cs_test_contract", url: "https://checkout.stripe.com/c/pay/cs_test_contract" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

const { default: handler } = await import("../api/stripe/checkout.js");
const response = {
  statusCode: 0,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  setHeader() {},
};

await handler(
  { method: "POST", headers: { origin: "https://tantapulse.com" }, body: { tier: "starter", email: "internal@example.test" } },
  response,
);

assert.equal(response.statusCode, 200);
assert.equal(response.body.ok, true);
assert.equal(captured.url, "https://api.stripe.com/v1/checkout/sessions");
const payload = new URLSearchParams(captured.options.body);
assert.equal(payload.get("mode"), "subscription");
assert.equal(payload.get("line_items[0][price]"), "price_1TtGYS5hHkfUnkHQjhNtiobD");
assert.equal(payload.get("line_items[0][price_data][unit_amount]"), null);
console.log("starter-price-contract: PASS");

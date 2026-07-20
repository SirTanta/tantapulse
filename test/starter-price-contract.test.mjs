import assert from "node:assert/strict";

process.env.STRIPE_SECRET_KEY = "unit-test-key";
let fetchCalls = 0;
let captured = null;
globalThis.fetch = async (url, options) => {
  fetchCalls += 1;
  captured = { url, options };
  return new Response(
    JSON.stringify({ id: "cs_test_contract", url: "https://checkout.stripe.com/c/pay/cs_test_contract" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

const { default: handler } = await import("../api/stripe/checkout.js");

function response() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader() {},
  };
}

for (const tier of ["growth", "enterprise", undefined, null, { target: "starter" }]) {
  const rejectedResponse = response();
  await handler(
    { method: "POST", headers: { origin: "https://tantapulse.com" }, body: { tier, email: "internal@example.test" } },
    rejectedResponse,
  );
  assert.equal(rejectedResponse.statusCode, 400, `tier ${String(tier)} must fail closed`);
  assert.equal(rejectedResponse.body.ok, undefined);
}
assert.equal(fetchCalls, 0, "Invalid targets must fail before Stripe payload construction or API invocation");

const starterResponse = response();
await handler(
  { method: "POST", headers: { origin: "https://tantapulse.com" }, body: { tier: "starter", email: "internal@example.test" } },
  starterResponse,
);
assert.equal(starterResponse.statusCode, 200);
assert.equal(starterResponse.body.ok, true);
assert.equal(fetchCalls, 1);
assert.equal(captured.url, "https://api.stripe.com/v1/checkout/sessions");
const payload = new URLSearchParams(captured.options.body);
assert.equal(payload.get("mode"), "subscription");
assert.equal(payload.get("line_items[0][price]"), "price_1TtGYS5hHkfUnkHQjhNtiobD");
assert.equal(payload.get("line_items[0][price_data][unit_amount]"), null);
console.log("starter-price-contract: PASS (Growth fail-closed; Starter canonical Price)");

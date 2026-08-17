import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFinanceEventKey,
  buildFinanceSignalKey,
  isOvernightUtcWindow,
  paginateStripeList,
  runStripeOvernightIngestion,
  selectNewFinanceSignals,
} from "../lib/finance-stripe-overnight.mjs";
import handler from "../api/finance/stripe-overnight.js";


test("only permits the configured UTC overnight window", () => {
  assert.equal(isOvernightUtcWindow(new Date("2026-07-19T00:00:00Z")), true);
  assert.equal(isOvernightUtcWindow(new Date("2026-07-19T05:59:59Z")), true);
  assert.equal(isOvernightUtcWindow(new Date("2026-07-19T06:00:00Z")), false);
});

test("paginates a Stripe list until has_more is false using only GET", async () => {
  const seen = [];
  const result = await paginateStripeList({
    path: "/charges",
    fetchImpl: async (url, options) => {
      seen.push({ url, method: options.method });
      if (seen.length === 1) {
        return new Response(JSON.stringify({ data: [{ id: "ch_first" }], has_more: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: "ch_last" }], has_more: false }), { status: 200 });
    },
    stripeKey: "test_key",
  });

  assert.deepEqual(result.items.map((item) => item.id), ["ch_first", "ch_last"]);
  assert.equal(result.hasMore, false);
  assert.deepEqual(seen.map((entry) => entry.method), ["GET", "GET"]);
  assert.match(seen[1].url, /starting_after=ch_first/);
});

test("dedupe keys are stable per Stripe entity while distinct entities remain distinct", () => {
  const date = "2026-07-19";
  const firstKey = buildFinanceEventKey("acct_123", "charge.ch_first", date);
  const duplicateKey = buildFinanceEventKey("acct_123", "charge.ch_first", date);
  const secondKey = buildFinanceEventKey("acct_123", "charge.ch_second", date);

  assert.equal(firstKey, "finance_event:acct_123:charge.ch_first:2026-07-19");
  assert.equal(firstKey, duplicateKey);
  assert.notEqual(firstKey, secondKey);
  assert.equal(buildFinanceSignalKey("ch_first", "stripe_charge"), "finance_signal:ch_first:stripe_charge");
});

test("selects only newly persisted events and reports duplicates without a candidate cap", () => {
  const candidates = [
    { entityId: "ch_first", signalType: "stripe_charge", eventType: "charge.ch_first" },
    { entityId: "ch_first", signalType: "stripe_charge", eventType: "charge.ch_first" },
    { entityId: "ch_second", signalType: "stripe_charge", eventType: "charge.ch_second" },
  ];
  const result = selectNewFinanceSignals(candidates, new Set(["finance_event:acct_123:charge.ch_first:2026-07-19"]), {
    accountId: "acct_123",
    eventDate: "2026-07-19",
  });

  assert.equal(result.candidateCount, 3);
  assert.equal(result.dedupeCount, 2);
  assert.deepEqual(result.newSignals.map((signal) => signal.entityId), ["ch_second"]);
});

test("rejects an untrusted scheduler invocation before any Stripe or persistence request", async () => {
  const originalFetch = global.fetch;
  const originalSecret = process.env.CRON_SECRET;
  let requests = 0;
  global.fetch = async () => { requests += 1; throw new Error("must not be called"); };
  process.env.CRON_SECRET = "test-cron-secret";
  const req = { method: "GET", headers: {} };
  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader() {},
  };

  try {
    await handler(req, response);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, { error: "Unauthorized" });
    assert.equal(requests, 0);
  } finally {
    global.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});

test("writes a sanitized no-op receipt outside the UTC window without calling Stripe", async () => {
  const receipts = [];
  const receipt = await runStripeOvernightIngestion({
    now: new Date("2026-07-19T06:00:00Z"),
    accountId: "acct_123",
    stripeKey: "test_key",
    fetchImpl: async () => { throw new Error("Stripe must not be called outside the window"); },
    store: { recordReceipt: async (row) => receipts.push(row), persistNewSignals: async () => ({ insertedCount: 0, dedupeCount: 0 }) },
  });
  assert.equal(receipt.mode, "outside_window_noop");
  assert.equal(receipt.candidate_count, 0);
  assert.equal(receipt.dedupe_count, 0);
  assert.equal(receipt.pagination_exhausted, false);
  assert.deepEqual(receipts, [receipt]);
});

test("does not claim a dedupe key when atomic signal persistence fails", async () => {
  const claimed = new Set();
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    const body = path.endsWith("/balance")
      ? { available: [], pending: [] }
      : path.endsWith("/charges")
      ? { data: [{ id: "ch_atomic", created: 1784422800 }], has_more: false }
      : { data: [], has_more: false };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const store = {
    recordReceipt: async () => {},
    persistNewSignals: async (signals) => {
      assert.equal(signals.length, 1);
      throw new Error("simulated transaction failure");
    },
  };
  await assert.rejects(
    runStripeOvernightIngestion({ now: new Date("2026-07-19T01:00:00Z"), accountId: "acct_123", stripeKey: "test_key", fetchImpl, store }),
    /simulated transaction failure/
  );
  assert.equal(claimed.size, 0);
});

test("re-running the same Stripe pages persists signals only once", async () => {
  const persistedDedupe = new Set();
  const persistedSignals = [];
  const receipts = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.method, "GET");
    const path = new URL(url).pathname;
    const body = path.endsWith("/balance")
      ? { available: [], pending: [] }
      : path.endsWith("/charges")
      ? { data: [{ id: "ch_1", created: 1784422800 }], has_more: false }
      : path.endsWith("/subscriptions")
      ? { data: [], has_more: false }
      : { data: [], has_more: false };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const store = {
    recordReceipt: async (row) => receipts.push(row),
    persistNewSignals: async (rows) => {
      const inserted = rows.filter((row) => !persistedDedupe.has(row.dedupeKey));
      inserted.forEach((row) => persistedDedupe.add(row.dedupeKey));
      persistedSignals.push(...inserted);
      return { insertedCount: inserted.length, dedupeCount: rows.length - inserted.length };
    },
  };
  const input = { now: new Date("2026-07-19T01:00:00Z"), accountId: "acct_123", stripeKey: "test_key", fetchImpl, store };
  const first = await runStripeOvernightIngestion(input);
  const second = await runStripeOvernightIngestion(input);

  assert.equal(first.candidate_count, 1);
  assert.equal(first.dedupe_count, 0);
  assert.equal(second.candidate_count, 1);
  assert.equal(second.dedupe_count, 1);
  assert.equal(persistedSignals.length, 1);
  assert.equal(receipts.length, 2);
});

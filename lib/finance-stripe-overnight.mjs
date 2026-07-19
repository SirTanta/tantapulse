const STRIPE_BASE_URL = "https://api.stripe.com/v1";

export function isOvernightUtcWindow(now = new Date()) {
  const hour = now.getUTCHours();
  return hour >= 0 && hour <= 5;
}

export function utcDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

export function buildFinanceEventKey(accountId, eventType, date) {
  return `finance_event:${accountId}:${eventType}:${date}`;
}

export function buildFinanceSignalKey(entityId, signalType) {
  return `finance_signal:${entityId}:${signalType}`;
}

function stripeHeaders(stripeKey) {
  return { Authorization: `Bearer ${stripeKey}` };
}

async function readStripeJson({ fetchImpl, stripeKey, path, query = {} }) {
  const url = new URL(`${STRIPE_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetchImpl(url.toString(), { method: "GET", headers: stripeHeaders(stripeKey) });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Stripe returned invalid JSON for ${path}`);
  }
  if (!response.ok) throw new Error(`Stripe read failed for ${path}: ${response.status}`);
  return payload;
}

export async function paginateStripeList({ fetchImpl = fetch, stripeKey, path, query = {} }) {
  const items = [];
  let startingAfter;
  let hasMore = false;
  do {
    const payload = await readStripeJson({ fetchImpl, stripeKey, path, query: { ...query, limit: 100, starting_after: startingAfter } });
    const page = Array.isArray(payload.data) ? payload.data : [];
    items.push(...page);
    hasMore = payload.has_more === true;
    if (hasMore && !page.at(-1)?.id) throw new Error(`Stripe pagination cursor missing for ${path}`);
    startingAfter = page.at(-1)?.id;
  } while (hasMore);
  return { items, hasMore: false };
}

function balanceCandidates(balance, runDate) {
  const result = [];
  for (const bucketType of ["available", "pending"]) {
    for (const entry of Array.isArray(balance?.[bucketType]) ? balance[bucketType] : []) {
      const currency = String(entry.currency || "unknown").toLowerCase();
      result.push({
        entityId: `balance.${bucketType}.${currency}`,
        eventType: `balance.${bucketType}.${currency}`,
        signalType: "stripe_balance",
        eventDate: runDate,
      });
    }
  }
  return result;
}

function listCandidates(items, source, signalType, runDate) {
  return items.filter((item) => item?.id).map((item) => ({
    entityId: item.id,
    eventType: `${source}.${item.id}`,
    signalType,
    eventDate: item.created ? utcDate(item.created * 1000) : runDate,
  }));
}

export async function collectStripeCandidates({ fetchImpl = fetch, stripeKey, now = new Date() }) {
  const runDate = utcDate(now);
  const balance = await readStripeJson({ fetchImpl, stripeKey, path: "/balance" });
  const [charges, subscriptions, balanceTransactions] = await Promise.all([
    paginateStripeList({ fetchImpl, stripeKey, path: "/charges" }),
    paginateStripeList({ fetchImpl, stripeKey, path: "/subscriptions", query: { status: "all" } }),
    paginateStripeList({ fetchImpl, stripeKey, path: "/balance_transactions" }),
  ]);
  return {
    candidates: [
      ...balanceCandidates(balance, runDate),
      ...listCandidates(charges.items, "charge", "stripe_charge", runDate),
      ...listCandidates(subscriptions.items, "subscription", "stripe_subscription", runDate),
      ...listCandidates(balanceTransactions.items, "balance_transaction", "stripe_balance_transaction", runDate),
    ],
    paginationExhausted: charges.hasMore === false && subscriptions.hasMore === false && balanceTransactions.hasMore === false,
    sources: { balance: 1, charges: charges.items.length, subscriptions: subscriptions.items.length, balance_transactions: balanceTransactions.items.length },
  };
}

export function selectNewFinanceSignals(candidates, existingKeys, { accountId, eventDate }) {
  const newSignals = [];
  const seen = new Set(existingKeys);
  let dedupeCount = 0;
  for (const candidate of candidates) {
    const keyDate = candidate.eventDate || eventDate;
    const dedupeKey = buildFinanceEventKey(accountId, candidate.eventType, keyDate);
    if (seen.has(dedupeKey)) {
      dedupeCount += 1;
      continue;
    }
    seen.add(dedupeKey);
    newSignals.push({ ...candidate, eventDate: keyDate, dedupeKey, signalKey: buildFinanceSignalKey(candidate.entityId, candidate.signalType) });
  }
  return { candidateCount: candidates.length, dedupeCount, newSignals };
}

export function makeReceipt({ now, windowOpen, candidateCount = 0, dedupeCount = 0, paginationExhausted = false, mode, sources = {} }) {
  return {
    run_timestamp_utc: new Date(now).toISOString(),
    window_open: windowOpen,
    candidate_count: candidateCount,
    dedupe_count: dedupeCount,
    pagination_exhausted: paginationExhausted,
    mode,
    sources,
  };
}

export async function runStripeOvernightIngestion({ now = new Date(), accountId, stripeKey, fetchImpl = fetch, store }) {
  if (!accountId || !stripeKey || !store?.recordReceipt || !store?.persistNewSignals) {
    throw new Error("Finance ingestion requires account ID, Stripe key, and durable store adapters");
  }
  const windowOpen = isOvernightUtcWindow(now);
  if (!windowOpen) {
    const receipt = makeReceipt({ now, windowOpen, mode: "outside_window_noop" });
    await store.recordReceipt(receipt);
    return receipt;
  }

  const collected = await collectStripeCandidates({ fetchImpl, stripeKey, now });
  const selected = selectNewFinanceSignals(collected.candidates, new Set(), { accountId, eventDate: utcDate(now) });
  const persisted = selected.newSignals.length
    ? await store.persistNewSignals(selected.newSignals)
    : { insertedCount: 0, dedupeCount: 0 };
  const dedupeCount = selected.dedupeCount + persisted.dedupeCount;
  const receipt = makeReceipt({ now, windowOpen, candidateCount: selected.candidateCount, dedupeCount, paginationExhausted: collected.paginationExhausted, mode: "read_only_ingestion", sources: collected.sources });
  await store.recordReceipt(receipt);
  return receipt;
}

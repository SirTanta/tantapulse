import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  isStale,
  isTestRequest,
  rankLeads,
  renderMarketCheck,
  renderOnboarding,
  renderPaidDelivery,
  scorePlace,
  unsubHeaders,
  isChain,
  isOutreachFollowUpDue,
  MONITORED_INBOX,
  OPS_EMAIL,
  OUTREACH_REPLY_TO,
  REPLY_TO,
  renderOutreach,
  renderOutreachFollowUp,
} from "../lib/pulse-fulfillment.mjs";
import { isPulseSession, readRawBody } from "../api/stripe/webhook.js";

test("replies, ops alerts, and unsubscribes never route to the unmonitored hello@ inbox", () => {
  assert.equal(REPLY_TO, MONITORED_INBOX);
  assert.equal(OPS_EMAIL, MONITORED_INBOX);
  assert.equal(OUTREACH_REPLY_TO, MONITORED_INBOX);
  assert.doesNotMatch(unsubHeaders("a@b.com")["List-Unsubscribe"], /mailto:/);
});

test("national chains are dropped from scored leads, local businesses are kept", () => {
  const ctx = { runId: "r1", niche: "hardware", city: "Austin, TX" };
  const places = [
    { title: "The Home Depot", reviewsCount: 2000 },
    { title: "Walmart Supercenter", reviewsCount: 5000 },
    { title: "ServPro of North Austin", reviewsCount: 40 },
    { title: "Progressive Dental Care", reviewsCount: 12 },
    { title: "Spectrum Roofing", reviewsCount: 8 },
    { title: "Barton Creek Hardware", reviewsCount: 30 },
  ];
  const names = rankLeads(places, ctx)
    .map((l) => l.business_name)
    .sort();
  assert.deepEqual(names, [
    "Barton Creek Hardware",
    "Progressive Dental Care",
    "Spectrum Roofing",
  ]);
  assert.equal(isChain({ title: "Aspen Dental - Round Rock" }), true);
});

test("test and junk intake rows are never fulfilled", () => {
  const junk = [
    {
      request_email: "a@tantapulse.invalid",
      niche: "dentists",
      city: "Austin",
    },
    { request_email: "a@example.com", niche: "roofing", city: "Austin, TX" },
    { request_email: "a@gmail.com", niche: "x", city: "a" },
    { request_email: "a@gmail.com", niche: "source-readback", city: "austin" },
    {
      request_email: "a@gmail.com",
      niche: "Re: Improve your website traffic",
      city: "Missouri City",
    },
    { request_email: "a@gmail.com", niche: "ABC", city: "Missouri City" },
  ];
  for (const row of junk)
    assert.equal(isTestRequest(row), true, JSON.stringify(row));
  assert.equal(
    isTestRequest({
      request_email: "owner@agency.com",
      niche: "dentists",
      city: "Austin, TX",
    }),
    false,
  );
});

test("backlog older than the window is expired, fresh requests are not", () => {
  const now = Date.parse("2026-09-26T00:00:00Z");
  assert.equal(isStale("2026-08-28T00:00:00Z", now), true);
  assert.equal(isStale("2026-09-25T00:00:00Z", now), false);
});

test("weak local presence scores higher than a strong one", () => {
  const weak = scorePlace({
    title: "A",
    reviewsCount: 4,
    totalScore: 3.9,
    claimThisBusiness: true,
    phone: "1",
    rank: 15,
  });
  const strong = scorePlace({
    title: "B",
    website: "https://b.com",
    reviewsCount: 900,
    totalScore: 4.9,
    phone: "1",
    rank: 1,
  });
  assert.ok(weak.score > strong.score);
  assert.equal(weak.band, "high");
  assert.ok(weak.reasons.includes("no website listed"));
});

test("ranking dedupes, drops closed places, and excludes previously delivered businesses", () => {
  const ctx = { runId: "r1", niche: "dentists", city: "Austin, TX" };
  const places = [
    { title: "Alpha Dental", website: "https://alpha.com", reviewsCount: 10 },
    {
      title: "Alpha Dental",
      website: "https://www.alpha.com/",
      reviewsCount: 10,
    },
    { title: "Closed Dental", permanentlyClosed: true },
    { title: "Beta Dental", phone: "512" },
  ];
  const all = rankLeads(places, ctx);
  assert.deepEqual(all.map((l) => l.business_name).sort(), [
    "Alpha Dental",
    "Beta Dental",
  ]);
  const again = rankLeads(
    places,
    ctx,
    new Set([
      all.find((l) => l.business_name === "Beta Dental").canonical_entity_id,
    ]),
  );
  assert.deepEqual(
    again.map((l) => l.business_name),
    ["Alpha Dental"],
  );
});

test("every outbound email carries the postal address, unsubscribe link, and escapes input", () => {
  const leads = [
    {
      business_name: "<b>Evil</b>",
      lead_score: 70,
      score_band: "high",
      score_reasons: ["no website listed"],
    },
  ];
  const emails = [
    renderMarketCheck({
      name: "Jo Smith",
      email: "jo@agency.com",
      niche: "dentists",
      city: "Austin, TX",
      leads,
      totalFound: 30,
    }),
    renderPaidDelivery({
      name: "Jo",
      email: "jo@agency.com",
      niche: "dentists",
      city: "Austin, TX",
      leads,
      tier: "pro",
    }),
    renderOnboarding({
      name: "Jo",
      email: "jo@agency.com",
      tier: "pro",
      niche: null,
      city: null,
    }),
  ];
  for (const { html, subject } of emails) {
    assert.ok(subject.length > 0);
    assert.match(html, /5325 Caprock Ct, Rio Rancho, NM 87144/);
    assert.match(html, /tantapulse\.com\/unsubscribe\?email=jo%40agency\.com/);
    assert.doesNotMatch(html, /<b>Evil<\/b>/);
  }
  assert.match(
    emails[0].html,
    /buy\.stripe\.com\/4gMdR274HeGo5Dl3ar5J606\?prefilled_email=jo%40agency\.com/,
  );
  assert.match(emails[2].html, /reply to this email with the niche and city/i);
  assert.match(
    unsubHeaders("jo@agency.com")["List-Unsubscribe"],
    /api\/unsubscribe\?email=jo%40agency\.com/,
  );
});

test("only Pulse payment links are treated as Pulse sales", () => {
  assert.equal(
    isPulseSession({ payment_link: "plink_1TtIav5hHkfUnkHQJydDLWQU" }),
    true,
  );
  assert.equal(
    isPulseSession({ payment_link: "plink_other", metadata: { tier: "pro" } }),
    false,
  );
  assert.equal(isPulseSession({ metadata: { product: "tantapulse" } }), true);
});

test("webhook reads the exact raw bytes Stripe signed", async () => {
  const raw = '{\n  "id": "evt_1",\n  "type": "x"\n}';
  const req = Readable.from([Buffer.from(raw)]);
  assert.equal(await readRawBody(req), raw);
});

test("outreach only sends in the weekday US business window and carries opt-out + address", async () => {
  const { inOutreachWindow } =
    await import("../lib/pulse-fulfillment.mjs");
  assert.equal(inOutreachWindow(new Date("2026-09-28T15:00:00Z")), true);
  assert.equal(inOutreachWindow(new Date("2026-09-26T15:00:00Z")), false);
  assert.equal(inOutreachWindow(new Date("2026-09-28T23:30:00Z")), false);
  const { subject, html } = renderOutreach({
    company: "<Acme> SEO",
    email: "a@acme.com",
  });
  assert.match(subject, /market check/i);
  assert.doesNotMatch(html, /<Acme>/);
  assert.match(html, /5325 Caprock Ct/);
  assert.match(html, /unsubscribe\?email=a%40acme\.com/);
  assert.match(html, /utm_campaign=seo_market_check/);
  assert.match(html, /only follow up once/i);
});

test("outreach follow-up is due after four business days and keeps compliance copy", () => {
  assert.equal(
    isOutreachFollowUpDue("2026-09-28T14:00:00Z", new Date("2026-10-02T13:59:59Z")),
    false,
  );
  assert.equal(
    isOutreachFollowUpDue("2026-09-28T14:00:00Z", new Date("2026-10-02T14:00:00Z")),
    true,
  );
  assert.equal(
    isOutreachFollowUpDue("2026-09-25T14:00:00Z", new Date("2026-10-01T14:00:00Z")),
    true,
  );
  const { subject, html } = renderOutreachFollowUp({
    company: "<Acme> SEO",
    email: "a@acme.com",
  });
  assert.match(subject, /follow-up/i);
  assert.doesNotMatch(html, /<Acme>/);
  assert.match(html, /5325 Caprock Ct/);
  assert.match(html, /unsubscribe\?email=a%40acme\.com/);
  assert.match(html, /utm_campaign=seo_market_check/);
});

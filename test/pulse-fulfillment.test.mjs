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
  isTantaOwnedEmail,
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

test("sender-owned probe recipients are recognized before Resend delivery", () => {
  assert.equal(isTantaOwnedEmail("holo-probe+tvp@tantaholdings.com"), true);
  assert.equal(isTantaOwnedEmail("qa@tanta-holdings.com"), true);
  assert.equal(isTantaOwnedEmail("buyer@example-agency.com"), false);
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

test("outreach promises one business day, not minutes (SLA is now()+1 day; fulfill cron is not guaranteed instant)", () => {
  const { html } = renderOutreach({ company: "Acme", email: "a@b.co" });
  assert.match(html, /within one business day/);
  assert.doesNotMatch(html, /within minutes|instantly|right away/i);
});

test("score bands: high >= 45, usable 25-44, low < 25 (matches public FAQ copy)", () => {
  const mk = (extra) => scorePlace({ website: "x.com", reviewsCount: 500, totalScore: 4.8, ...extra }, { medianReviews: 50 });
  assert.equal(scorePlace({ website: "", reviewsCount: 0, totalScore: 0 }, { medianReviews: 50 }).band, "high"); // 30+30
  assert.equal(mk({ claimThisBusiness: true, rank: 12 }).band, "usable"); // 15+12 = 27
  assert.equal(mk({ claimThisBusiness: true }).band, "low"); // 15
});

test("outreach greets the owner by first name only when a high-confidence name is set (flag on)", () => {
  process.env.PULSE_OWNER_GREETING = "on";
  try {
    const named = renderOutreach({ company: "Acme SEO", email: "a@acme.com", ownerFirstName: "jane" });
    assert.match(named.html, /<p style="margin:0 0 12px">Hi Jane,<\/p>/);
    assert.doesNotMatch(named.html, /Hi Acme SEO/);
    const plain = renderOutreach({ company: "Acme SEO", email: "a@acme.com" });
    assert.equal(named.subject, plain.subject, "subject unchanged");
    assert.match(plain.html, /Hi Acme SEO,/);
    // everything after the greeting is identical
    const rest = (h) => h.slice(h.indexOf("</p>"));
    assert.equal(rest(named.html), rest(plain.html));
    const fu = renderOutreachFollowUp({ company: "Acme SEO", email: "a@acme.com", ownerFirstName: "Jane" });
    assert.match(fu.html, /Hi Jane,/);
  } finally {
    delete process.env.PULSE_OWNER_GREETING;
  }
});

test("outreach fallback greeting is exactly the old company greeting (no name, flag off, bad name)", () => {
  const old = renderOutreach({ company: "Acme SEO", email: "a@acme.com" }).html;
  assert.match(old, /Hi Acme SEO,/);
  assert.match(renderOutreach({ email: "a@acme.com" }).html, /Hi your team,/);
  process.env.PULSE_OWNER_GREETING = "off";
  try {
    assert.equal(renderOutreach({ company: "Acme SEO", email: "a@acme.com", ownerFirstName: "Jane" }).html, old);
  } finally {
    delete process.env.PULSE_OWNER_GREETING;
  }
  process.env.PULSE_OWNER_GREETING = "on";
  try {
    for (const bad of [null, "", "J", "ACME", "Owner", "Jane Doe"]) {
      assert.equal(renderOutreach({ company: "Acme SEO", email: "a@acme.com", ownerFirstName: bad }).html, old, String(bad));
    }
  } finally {
    delete process.env.PULSE_OWNER_GREETING;
  }
});

test("outreach owner name is sanitized: HTML/injection characters never reach the email", () => {
  process.env.PULSE_OWNER_GREETING = "on";
  try {
    for (const evil of ["<script>alert(1)</script>", 'Jane"><img src=x onerror=1>', "Jane&amp;", "Ja<b>ne"]) {
      const { html } = renderOutreach({ company: "Acme", email: "a@acme.com", ownerFirstName: evil });
      assert.doesNotMatch(html, /<script|<img|onerror|<b>ne/i, evil);
      assert.match(html, /Hi Acme,/, "falls back to the company greeting");
    }
    assert.match(renderOutreach({ company: "Acme", email: "a@acme.com", ownerFirstName: "mary-ann" }).html, /Hi Mary-Ann,/);
    assert.match(renderOutreach({ company: "Acme", email: "a@acme.com", ownerFirstName: "o'brien" }).html, /Hi O(&#39;|')Brien,/);
  } finally {
    delete process.env.PULSE_OWNER_GREETING;
  }
});

test("leadOwnerName only honours owner_name_confidence = high", async () => {
  const { leadOwnerName } = await import("../lib/pulse-fulfillment.mjs");
  assert.equal(leadOwnerName({ owner_first_name: "Jane", owner_name_confidence: "high" }), "Jane");
  assert.equal(leadOwnerName({ owner_first_name: "Jane", owner_name_confidence: null }), null);
  assert.equal(leadOwnerName({ owner_first_name: "Jane", owner_name_confidence: "low" }), null);
  assert.equal(leadOwnerName({}), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeFirstName,
  ownerFromHunter,
  ownerFromWebsite,
  extractOwnerNames,
  htmlToText,
  pickOwner,
  robotsAllows,
  mailboxAllowsOwner,
  resolveOwnerName,
  isRoleMailbox,
} from "../lib/owner-name.mjs";
import { bridgeOne } from "../lib/lead-feed-bridge.mjs";

const hunterEmail = (over = {}) => ({
  value: "jane@acme.com",
  type: "personal",
  confidence: 95,
  first_name: "Jane",
  last_name: "Doe",
  position: "Owner",
  verification: { status: "valid" },
  ...over,
});

// ---- Hunter path ---------------------------------------------------------------------------

test("hunter: owner position + matching local part is accepted (high confidence)", () => {
  const r = ownerFromHunter(
    hunterEmail(),
    { emails: [hunterEmail()] },
    "Acme Roofing",
  );
  assert.equal(r.ok, true);
  assert.equal(r.first_name, "Jane");
  assert.equal(r.source, "hunter");
  assert.equal(r.confidence, "high");
});

test("hunter: jane.doe@, jdoe@ and janed@ local parts all count as consistent", () => {
  for (const value of ["jane.doe@acme.com", "jdoe@acme.com", "janed@acme.com"]) {
    assert.equal(
      ownerFromHunter(hunterEmail({ value, confidence: 82 }), null, "Acme").ok,
      true,
      value,
    );
  }
});

test("hunter: role mailbox is rejected even when Hunter attaches an owner name", () => {
  for (const value of [
    "info@acme.com",
    "sales@acme.com",
    "hello@acme.com",
    "contact@acme.com",
  ]) {
    const r = ownerFromHunter(hunterEmail({ value }), null, "Acme");
    assert.equal(r.ok, false, value);
    assert.equal(r.reason, "role_mailbox");
  }
  assert.equal(isRoleMailbox("jane@acme.com"), false);
});

test("hunter: low confidence + local part that does not match the name is rejected", () => {
  const r = ownerFromHunter(
    hunterEmail({ value: "bob@acme.com", confidence: 85 }),
    null,
    "Acme",
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /local_part_mismatch/);
  // at >= 90 the confidence alone is enough per the rule
  assert.equal(
    ownerFromHunter(
      hunterEmail({ value: "bob@acme.com", confidence: 90 }),
      null,
      "Acme",
    ).ok,
    true,
  );
});

test("hunter: only owner-type positions count (not vice president, manager, co-owner, assistant)", () => {
  for (const position of [
    "Marketing Manager",
    "Vice President",
    "Assistant to the President",
    "Co-Owner",
    "Sales Director",
  ]) {
    assert.equal(
      ownerFromHunter(hunterEmail({ position }), null, "Acme").ok,
      false,
      position,
    );
  }
  for (const position of [
    "Founder",
    "Co-Founder",
    "CEO",
    "President",
    "Principal",
    "Managing Partner",
    "Owner and Operator",
  ]) {
    assert.equal(
      ownerFromHunter(hunterEmail({ position }), null, "Acme").ok,
      true,
      position,
    );
  }
});

test("hunter: ambiguous - two owner-position people with different first names is rejected", () => {
  const other = hunterEmail({
    value: "mark@acme.com",
    first_name: "Mark",
    last_name: "Roe",
    position: "Co-Founder",
  });
  const r = ownerFromHunter(
    hunterEmail(),
    { emails: [hunterEmail(), other] },
    "Acme",
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "multiple_owner_candidates");
});

test("hunter: generic-type and nameless emails are rejected; a name equal to the business is rejected", () => {
  assert.equal(ownerFromHunter(hunterEmail({ type: "generic" }), null, "Acme").ok, false);
  assert.equal(ownerFromHunter(hunterEmail({ first_name: null }), null, "Acme").ok, false);
  const r = ownerFromHunter(
    hunterEmail({ value: "sunrise@sunrise.com", first_name: "Sunrise", last_name: "" }),
    null,
    "Sunrise",
  );
  assert.equal(r.ok, false);
});

// ---- sanitizing ----------------------------------------------------------------------------

test("sanitizeFirstName: letters, hyphen and apostrophe only, title-cased; junk is rejected", () => {
  assert.equal(sanitizeFirstName("jane"), "Jane");
  assert.equal(sanitizeFirstName("MARY-ANN"), null, "all caps is junk");
  assert.equal(sanitizeFirstName("mary-ann"), "Mary-Ann");
  assert.equal(sanitizeFirstName("o'brien"), "O'Brien");
  assert.equal(sanitizeFirstName("J"), null);
  assert.equal(sanitizeFirstName("<script>alert(1)</script>"), null);
  assert.equal(sanitizeFirstName("Jane<b>"), null);
  assert.equal(sanitizeFirstName('Jane"onload='), null);
  assert.equal(sanitizeFirstName("Jane Doe"), null, "first name only");
  assert.equal(sanitizeFirstName("Jane2"), null);
  assert.equal(sanitizeFirstName("Owner"), null);
  assert.equal(sanitizeFirstName("Team"), null);
  assert.equal(sanitizeFirstName(null), null);
});

// ---- website path --------------------------------------------------------------------------

function fakeSite(pages, robots = "") {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const body = u.pathname === "/robots.txt" ? robots : pages[u.pathname];
    if (body === undefined)
      return { ok: false, status: 404, headers: { get: () => "text/html" }, text: async () => "", url };
    return { ok: true, status: 200, headers: { get: () => "text/html" }, text: async () => body, url };
  };
  return { fetchImpl, calls };
}

test("website: an explicitly labelled owner is accepted, from the linked About page", async () => {
  const site = fakeSite({
    "/": '<html><a href="/about-us">About</a><p>We are Acme.</p></html>',
    "/about-us": "<h2>Our story</h2><p>Jane Doe, Owner</p><p>We love roofs.</p>",
  });
  const r = await ownerFromWebsite("acme.com", "Acme Roofing", { fetchImpl: site.fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.first_name, "Jane");
  assert.equal(r.source, "website");
  assert.equal(r.confidence, "high");
  assert.ok(site.calls.length <= 3, "robots + homepage + one about page at most");
  assert.ok(site.calls.every((u) => new URL(u).hostname === "acme.com"), "same domain only");
});

test("website: 'Founded by' and 'is the founder' phrasing are accepted", () => {
  assert.deepEqual(
    extractOwnerNames("Brightlark was founded by Matt Walde in 2004", "Brightlark").map((n) => n.full),
    ["matt walde"],
  );
  assert.deepEqual(
    extractOwnerNames("Sean is the Founder and Creative Director of Anchovies.", "Anchovies Studio").map((n) => n.first),
    ["Sean"],
  );
});

test("website: ambiguous - two different owners labelled is rejected", async () => {
  const site = fakeSite({ "/": "<p>Jane Doe, Owner</p><p>Mark Roe, Co-Founder</p>" });
  const r = await ownerFromWebsite("acme.com", "Acme", { fetchImpl: site.fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "multiple_owner_candidates");
  assert.equal(pickOwner([]).ok, false);
});

test("website: a label that is just the business/brand name is rejected", async () => {
  const site = fakeSite({ "/": "<p>Owner: Salterra</p><p>Founder, Webb</p>" });
  assert.equal(
    (await ownerFromWebsite("salterra.com", "Salterra", { fetchImpl: site.fetchImpl })).ok,
    false,
  );
  assert.deepEqual(extractOwnerNames("Dirrax Web Design, CEO Dirrax", "Dirrax Web Design"), []);
});

test("website: testimonials, vice titles, co-owners and 'owner of <other company>' are not accepted", () => {
  assert.deepEqual(
    extractOwnerNames('"Great service!" - Sam Smith, Owner of Smith Plumbing', "Acme"),
    [],
  );
  assert.deepEqual(extractOwnerNames("Pat Lee, Vice President", "Acme"), []);
  assert.deepEqual(extractOwnerNames("Pat Lee, Co-Owner", "Acme"), []);
  assert.deepEqual(extractOwnerNames("Pat Lee, Owner, Lee Plumbing LLC", "Acme"), []);
  assert.deepEqual(extractOwnerNames("Contact Us | Owner | Strategy", "Acme"), []);
});

test("website: title-adjacent single words need a first and last name", () => {
  assert.deepEqual(extractOwnerNames("President, Cielo", "Launch Marketing"), []);
  assert.deepEqual(
    extractOwnerNames("Founder, Artists Are Scientists", "Artists Are Scientists"),
    [],
  );
});

test("website: robots.txt disallow is respected and nothing beyond robots.txt is fetched", async () => {
  const site = fakeSite({ "/": "<p>Jane Doe, Owner</p>" }, "User-agent: *\nDisallow: /\n");
  const r = await ownerFromWebsite("acme.com", "Acme", { fetchImpl: site.fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "robots_disallow");
  assert.deepEqual(site.calls.map((u) => new URL(u).pathname), ["/robots.txt"]);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /about\n", "/about-us"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /*?x=*\n", "/team"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /feed/\n", "/about"), true);
});

test("website: redirect off the domain and fetch failures are rejected, never thrown", async () => {
  const off = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "text/html" },
    text: async () => "<p>Jane Doe, Owner</p>",
    url: "https://other.com/",
  });
  assert.equal(
    (await ownerFromWebsite("acme.com", "Acme", { fetchImpl: off })).reason,
    "redirected_off_domain",
  );
  const boom = async () => {
    throw new Error("network");
  };
  assert.equal((await ownerFromWebsite("acme.com", "Acme", { fetchImpl: boom })).ok, false);
});

test("website: a name is only used when the mailbox is a role mailbox or belongs to that person", async () => {
  assert.equal(mailboxAllowsOwner({ value: "info@acme.com" }, "Jim").ok, true);
  assert.equal(mailboxAllowsOwner({ value: "jim@acme.com" }, "Jim").ok, true);
  assert.equal(
    mailboxAllowsOwner({ value: "jessica@acme.com", first_name: "Jessica" }, "Jim").reason,
    "mailbox_belongs_to_other_person",
  );
  assert.equal(
    mailboxAllowsOwner({ value: "xk@acme.com" }, "Jim").reason,
    "mailbox_unverified_person",
  );
  const site = fakeSite({ "/": "<p>Jim Singelyn, founder</p>" });
  const r = await resolveOwnerName({
    email: hunterEmail({ value: "jessica@acme.com", first_name: "Jessica", position: "Designer" }),
    business: "AGI",
    domain: "acme.com",
    fetchImpl: site.fetchImpl,
  });
  assert.equal(r.ok, false);
});

test("htmlToText keeps block boundaries so names do not merge with neighbouring words", () => {
  assert.match(htmlToText("<p>Jane Doe</p><p>Owner</p>"), /Jane Doe \|[ |]*Owner/);
});

// ---- bridge wiring -------------------------------------------------------------------------

function fakeDb() {
  const inserts = { contacts: [], leads: [] };
  return {
    inserts,
    get: async () => [],
    insert: async (table, body) => {
      inserts[table].push(body);
      return [{ id: `${table}-1` }];
    },
    patch: async () => null,
  };
}

test("bridgeOne stores a high-confidence Hunter owner name on the leads row, and nothing otherwise", async (t) => {
  const d = fakeDb();
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { emails: [hunterEmail()] } }),
  }));
  await bridgeOne(d, { id: 1, business_name: "Acme Roofing", website: "https://acme.com" }, "key", [], {
    allowWebsite: false,
  });
  assert.equal(d.inserts.leads[0].owner_first_name, "Jane");
  assert.equal(d.inserts.leads[0].owner_name_source, "hunter");
  assert.equal(d.inserts.leads[0].owner_name_confidence, "high");

  const d2 = fakeDb();
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { emails: [hunterEmail({ value: "info@acme.com" })] } }),
  }));
  await bridgeOne(d2, { id: 2, business_name: "Acme Roofing", website: "https://acme.com" }, "key", [], {
    allowWebsite: false,
  });
  assert.equal(d2.inserts.leads[0].owner_first_name, null);
  assert.equal(d2.inserts.leads[0].owner_name_source, null);
  assert.equal(d2.inserts.leads[0].owner_name_confidence, null);
});

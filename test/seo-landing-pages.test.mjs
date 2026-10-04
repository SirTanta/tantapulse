import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const pub = (p) => new URL(`../public/${p}`, import.meta.url);
const slugs = ["austin-seo-agency-leads", "local-seo-agency-leads", "hvac-leads", "roofing-leads"];

// Same bar as public-copy-contract: no invented proof or outcome claims.
const forbidden = [
  /guarantee(d|s)?\b/i,
  /risk[-\s]free/i,
  /money[-\s]back/i,
  /\d+\s*%\s*(more|increase|lift|conversion|close)/i,
  /\d+\s*x\s+(roi|return|more\s+leads)/i,
  /\btrusted\s+by\b/i,
  /\bas\s+seen\s+(in|on)\b/i,
  /\btestimonial/i,
  /\bcase\s+stud(y|ies)\b/i,
  /\bbest\b/i,
  /\bexclusive\s+leads\s+(only|guaranteed)/i,
];

const visibleText = (html) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
for (const slug of slugs) {
  assert.ok(
    vercel.rewrites.some((r) => r.source === `/${slug}` && r.destination === `/${slug}.html`),
    `${slug}: vercel.json needs a clean-URL rewrite to its .html file`,
  );
}

const sitemap = await readFile(pub("sitemap.xml"), "utf8");
const home = await readFile(pub("index.html"), "utf8");
const titles = new Set();
const descriptions = new Set();
const bodies = [];

for (const slug of slugs) {
  const html = await readFile(pub(`${slug}.html`), "utf8");
  const url = `https://tantapulse.com/${slug}`;
  const title = html.match(/<title>([^<]*)<\/title>/)[1];
  const desc = html.match(/<meta name="description" content="([^"]*)"/)[1];
  assert.ok(title.length >= 50 && title.length <= 60, `${slug}: title length ${title.length}`);
  assert.ok(desc.length >= 120 && desc.length <= 160, `${slug}: description length ${desc.length}`);
  assert.ok(!titles.has(title), `${slug}: duplicate title`);
  assert.ok(!descriptions.has(desc), `${slug}: duplicate description`);
  titles.add(title);
  descriptions.add(desc);
  assert.match(html, new RegExp(`<link rel="canonical" href="${url}" />`), `${slug}: canonical`);
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${slug}: exactly one h1`);
  // heading order: never skip a level going down
  let prev = 0;
  for (const m of html.matchAll(/<h([1-6])[\s>]/g)) {
    const level = Number(m[1]);
    assert.ok(level <= prev + 1, `${slug}: heading jumps h${prev} -> h${level}`);
    prev = level;
  }
  assert.ok(sitemap.includes(`<loc>${url}</loc>`), `${slug}: in sitemap.xml`);
  assert.ok(home.includes(`href="/${slug}"`), `${slug}: linked from homepage`);
  // Market check paused 2026-10-05 (Maps-sourcing terms): no form, notice + mailto only.
  assert.doesNotMatch(html, /<form[ >]/, `${slug}: no form while market check is paused`);
  assert.doesNotMatch(html, /sample-form|api.sample-request/, `${slug}: no sample-request wiring`);
  assert.match(html, /id="market-check-notice"/, `${slug}: paused notice present`);
  assert.match(html, /temporarily unavailable while we move to a new data source/, `${slug}: notice copy`);
  assert.match(html, /href="mailto:hello@tantapulse.com/, `${slug}: mailto link`);
  const text = visibleText(html);
  for (const re of forbidden) assert.doesNotMatch(text, re, `${slug}: forbidden claim ${re}`);
  assert.match(text, /\$49[\s\S]*\$149[\s\S]*\$399/, `${slug}: states $49/$149/$399`);
  bodies.push(visibleText(html.replace(/<section[^>]*id="request"[\s\S]*?<\/section>/, "")));
}

// Rough duplicate guard: no 12-word run shared between two pages' main copy.
function shingles(text) {
  const w = text.toLowerCase().split(" ");
  const out = new Set();
  for (let i = 0; i + 12 <= w.length; i++) out.add(w.slice(i, i + 12).join(" "));
  return out;
}
const boiler = /form|privacy policy|tanta holdings|email preferences|market check/;
for (let i = 0; i < bodies.length; i++) {
  for (let j = i + 1; j < bodies.length; j++) {
    const a = shingles(bodies[i]);
    const shared = [...shingles(bodies[j])].filter((s) => a.has(s) && !boiler.test(s));
    assert.ok(shared.length <= 4, `${slugs[i]} vs ${slugs[j]} share ${shared.length} 12-word runs, e.g. "${shared[0]}"`);
  }
}

// IndexNow: key file is public and its content equals its filename.
const keyFiles = (await readdir(pub(""))).filter((n) => /^[a-f0-9]{32}\.txt$/.test(n));
assert.equal(keyFiles.length, 1, "exactly one IndexNow key file in public/");
const keyBody = (await readFile(pub(keyFiles[0]), "utf8")).trim();
assert.equal(`${keyBody}.txt`, keyFiles[0], "IndexNow key file content must equal its name");
assert.match(sitemap, /<loc>https:\/\/tantapulse\.com\/<\/loc>/);

console.log("seo-landing-pages: PASS");

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

// Jon decision: the public Tanta Pulse contact is hello@tantapulse.com. Tanta Holdings
// addresses (info@tanta-holdings.com etc.) must never appear on public Pulse pages.
const roots = [new URL("../", import.meta.url), new URL("../public/", import.meta.url)];
const banned = /(info|jedwards|support|contact)@tanta-?holdings\.com/i;

let checked = 0;
for (const root of roots) {
  const pages = (await readdir(root)).filter((f) => f.endsWith(".html"));
  for (const page of pages) {
    const html = await readFile(new URL(page, root), "utf8");
    assert.doesNotMatch(html, banned, `${page} must not expose a Tanta Holdings contact address`);
    checked++;
  }
}
assert.ok(checked >= 8, "expected to scan the root and public html pages");

for (const page of ["pricing.html", "public/pricing.html"]) {
  const html = await readFile(new URL(`../${page}`, import.meta.url), "utf8");
  assert.match(html, /mailto:hello@tantapulse\.com/, `${page} must offer hello@tantapulse.com`);
}

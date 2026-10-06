#!/usr/bin/env node
/**
 * IndexNow submission (https://www.indexnow.org/documentation).
 *
 * Notifies Bing, Yandex and other IndexNow participants that URLs changed.
 * The key is public by design: it lives in public/<key>.txt and the file
 * content must equal the key. Run AFTER the deploy that serves the key file.
 *
 * Usage:
 *   node scripts/indexnow.mjs              # submit every URL in public/sitemap.xml
 *   node scripts/indexnow.mjs --dry-run    # print the payload only
 *   node scripts/indexnow.mjs <url> [...]  # submit specific URLs
 */
import { readFile, readdir } from "node:fs/promises";

const ENDPOINT = "https://api.indexnow.org/indexnow";
const publicDir = new URL("../public/", import.meta.url);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const explicitUrls = args.filter((a) => !a.startsWith("--"));

async function findKey() {
  for (const name of await readdir(publicDir)) {
    const m = name.match(/^([a-f0-9]{32})\.txt$/);
    if (!m) continue;
    const body = (await readFile(new URL(name, publicDir), "utf8")).trim();
    if (body === m[1]) return m[1];
  }
  throw new Error("no IndexNow key file (public/<32-hex>.txt containing its own name) found");
}

const sitemap = await readFile(new URL("sitemap.xml", publicDir), "utf8");
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
const urlList = explicitUrls.length ? explicitUrls : sitemapUrls;
const host = new URL(urlList[0]).host;
const key = await findKey();
const payload = { host, key, keyLocation: `https://${host}/${key}.txt`, urlList };

if (dryRun) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(payload),
});
console.log(`IndexNow ${host}: HTTP ${res.status} ${res.statusText} (${urlList.length} URLs)`);
console.log((await res.text()).slice(0, 500));
process.exit(res.status === 200 || res.status === 202 ? 0 : 1);

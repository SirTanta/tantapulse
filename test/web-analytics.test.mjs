import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const SCRIPT = '<script defer src="/_vercel/insights/script.js"></script>';
const SHIM = "window.va = window.va ||";

const pageNames = (await readdir(new URL("../public/", import.meta.url))).filter((f) => f.endsWith(".html"));
for (const required of ["index.html", "pricing.html", "unsubscribe.html", "austin-seo-agency-leads.html", "local-seo-agency-leads.html", "hvac-leads.html", "roofing-leads.html"]) {
  assert.ok(pageNames.includes(required), `public/${required} exists`);
}

const targets = [...pageNames.map((f) => `public/${f}`), "index.html", "pricing.html", "unsubscribe.html"];
for (const rel of targets) {
  const html = await readFile(new URL(`../${rel}`, import.meta.url), "utf8");
  assert.equal(html.split(SCRIPT).length - 1, 1, `${rel} has exactly one Vercel Web Analytics script`);
  assert.ok(html.includes(SHIM), `${rel} has the window.va queue shim`);
  assert.ok(html.indexOf(SHIM) < html.indexOf(SCRIPT), `${rel} shim precedes script`);
  assert.ok(html.indexOf(SCRIPT) < html.indexOf("</head>"), `${rel} script is inside <head>`);
  assert.ok(!/content-security-policy/i.test(html), `${rel} has no CSP meta that could block the script`);
}

// Cookieless contract: no headers config that sets cookies, and no CSP that could block /_vercel/insights.
const vercelJson = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
const headersText = JSON.stringify(vercelJson.headers || []);
assert.ok(!/set-cookie/i.test(headersText), "vercel.json does not set cookies");
assert.ok(!/content-security-policy/i.test(headersText), "vercel.json defines no CSP");
console.log("web-analytics contract ok");

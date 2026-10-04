import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const OG = "https://tantapulse.com/og-card.png";
const pageNames = (await readdir(new URL("../public/", import.meta.url))).filter((f) => f.endsWith(".html"));
const targets = [...pageNames.map((f) => `public/${f}`), "index.html", "pricing.html", "unsubscribe.html"];

for (const rel of targets) {
  const html = await readFile(new URL(`../${rel}`, import.meta.url), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  assert.ok(head.includes(`<meta property="og:image" content="${OG}" />`), `${rel} has og:image`);
  assert.ok(head.includes('<meta property="og:image:width" content="1200" />'), `${rel} has og:image:width`);
  assert.ok(head.includes('<meta property="og:image:height" content="630" />'), `${rel} has og:image:height`);
  assert.ok(/<meta property="og:image:alt" content="[^"]+" \/>/.test(head), `${rel} has og:image:alt`);
  assert.ok(head.includes('<meta name="twitter:card" content="summary_large_image" />'), `${rel} has twitter:card summary_large_image`);
  assert.ok(head.includes(`<meta name="twitter:image" content="${OG}" />`), `${rel} has twitter:image`);
}

// The card itself must be a real 1200x630 PNG.
const png = await readFile(new URL("../public/og-card.png", import.meta.url));
assert.equal(png.subarray(1, 4).toString(), "PNG", "og-card.png is a PNG");
assert.equal(png.readUInt32BE(16), 1200, "og-card.png width");
assert.equal(png.readUInt32BE(20), 630, "og-card.png height");
console.log("og-image contract ok");

#!/usr/bin/env node
"use strict";

/**
 * cli.js — Hermes service-gated CLI for the wiki-read-adapter.
 *
 * Usage:
 *   WIKI_READ_ADAPTER_BASE_URL=https://wiki.tantaholdings.com \
 *   WIKI_READ_ADAPTER_API_TOKEN=$(infisical secrets get WIKI_READ_ADAPTER_API_TOKEN --projectId 585b5bee-a123-4323-bd32-4d924d98b950 --env prod --plain) \
 *   node src/cli.js --caller lexi --path /agents/lexi --pinned-revision <sha>
 *
 * Exits non-zero on any authorization, credential, backend, or provenance
 * failure. Prints one JSON object on stdout.
 */

const { readCanonicalPage } = require("./orchestrator.js");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith("--")) throw new Error(`unexpected arg: ${t}`);
    const k = t.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`missing value for --${k}`);
    out[k.replace(/-/g, "_")] = v;
    i += 1;
  }
  return out;
}

(async () => {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await readCanonicalPage({
      caller: args.caller,
      requestedPath: args.path,
      pinnedRevision: args.pinned_revision,
      pinnedSha256: args.pinned_sha256,
      expectedPath: args.expected_path,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err.code || "adapter_error", message: err.message }) + "\n");
    process.exitCode = 1;
  }
})();

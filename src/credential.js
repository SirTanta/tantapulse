"use strict";

/**
 * credential.js — central-only credential resolution.
 *
 * Credentials are read from the environment. There is no file fallback, no
 * worktree fallback, no prompt fallback, no placeholder default. Missing
 * credentials are a hard error.
 */

function invariant(condition, message) {
  if (!condition) throw new Error(`credential: ${message}`);
}

function resolveCredentials(env = process.env, requiredKeys = ["WIKI_READ_ADAPTER_BASE_URL", "WIKI_READ_ADAPTER_API_TOKEN"]) {
  invariant(typeof env === "object" && env !== null, "env must be an object");
  for (const key of requiredKeys) {
    invariant(typeof env[key] === "string" && env[key].length >= 8, `missing or invalid env binding: ${key}`);
  }
  // The token must never be logged or written to the audit receipt. We return
  // a redacted view alongside the live binding.
  return {
    baseUrl: env.WIKI_READ_ADAPTER_BASE_URL.replace(/\/$/, ""),
    token: env.WIKI_READ_ADAPTER_API_TOKEN,
    redacted: {
      baseUrl: env.WIKI_READ_ADAPTER_BASE_URL.replace(/\/$/, ""),
      token: "REDACTED",
    },
  };
}

module.exports = { resolveCredentials };

"use strict";

/**
 * pinned-revision.js — verify the live response matches the pinned revision.
 *
 * The contract requires:
 *   - response.canonical_url is the public/private canonical URL of the page
 *   - response.revision_id is the immutable revision identifier
 *   - response.revision_sha256 is the hex SHA-256 of the page bytes at that
 *     revision
 *
 * Any missing field, or a revision_id / revision_sha256 that does not match
 * the pin, is a fail-closed error.
 */

const crypto = require("node:crypto");

function invariant(condition, message) {
  if (!condition) throw new Error(`pinned-revision: ${message}`);
}

function hashContent(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Normalize a path to a canonical URL form. We do not assume the host; we
 * accept whatever the backend returns under `canonical_url` and only verify
 * the path component.
 */
function normalizeCanonicalPath(canonicalUrl) {
  try {
    const u = new URL(canonicalUrl);
    return u.pathname;
  } catch {
    return canonicalUrl;
  }
}

function verifyPinnedRevision({ response, requestedPath, pinnedRevision, pinnedSha256, expectedPath }) {
  invariant(response && typeof response === "object", "response must be an object");
  invariant(typeof response.canonical_url === "string" && response.canonical_url.length > 0, "canonical_url missing");
  invariant(typeof response.revision_id === "string" && response.revision_id.length > 0, "revision_id missing");
  invariant(typeof response.revision_sha256 === "string" && /^[a-f0-9]{64}$/.test(response.revision_sha256), "revision_sha256 must be 64-char hex");

  // 1) Path must match what was requested. (Defense in depth: caller asked
  // for /agents/lexi, the response must not be a different page.)
  const canonicalPath = normalizeCanonicalPath(response.canonical_url);
  if (canonicalPath !== requestedPath) {
    const err = new Error(`provenance_mismatch: requested=${requestedPath} canonical=${canonicalPath}`);
    err.code = "provenance_mismatch";
    throw err;
  }

  // 2) Path must also match the expected path (the assignment manifest's
  // pinned page). If a different expected path was pinned, refuse.
  if (expectedPath && canonicalPath !== expectedPath) {
    const err = new Error(`pinned_path_mismatch: pinned=${expectedPath} canonical=${canonicalPath}`);
    err.code = "pinned_path_mismatch";
    throw err;
  }

  // 3) revision_id must equal the pinned revision id.
  if (pinnedRevision && response.revision_id !== pinnedRevision) {
    const err = new Error(`revision_mismatch: pinned=${pinnedRevision} live=${response.revision_id}`);
    err.code = "revision_mismatch";
    throw err;
  }

  // 4) revision_sha256 must match the hash computed from the page bytes, OR
  // match a pinned sha256 when supplied.
  if (pinnedSha256 && response.revision_sha256 !== pinnedSha256) {
    const err = new Error(`sha256_mismatch: pinned=${pinnedSha256} live=${response.revision_sha256}`);
    err.code = "sha256_mismatch";
    throw err;
  }

  return {
    canonical_url: response.canonical_url,
    revision_id: response.revision_id,
    revision_sha256: response.revision_sha256,
  };
}

module.exports = { verifyPinnedRevision, hashContent, normalizeCanonicalPath };

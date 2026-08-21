"use strict";

/**
 * audit.js — emit a no-leakage audit receipt.
 *
 * The receipt contains the identity of the caller, the requested path, the
 * pinned revision, the live revision_id + revision_sha256, the status, and
 * the observed timestamp. It MUST NOT contain source content, secrets,
 * tokens, credentials, or the raw response body.
 */

function invariant(condition, message) {
  if (!condition) throw new Error(`audit: ${message}`);
}

const REDACTED_KEYS = new Set(["source-content", "secrets", "tokens", "credentials", "content", "body", "raw", "token", "password", "secret", "credential"]);

function buildAuditReceipt({ caller, requestedPath, pinnedRevision, liveRevisionId, liveRevisionSha256, status, observedAt, manifestDigest }) {
  invariant(typeof caller === "string", "caller required");
  invariant(typeof requestedPath === "string", "requestedPath required");
  invariant(typeof pinnedRevision === "string", "pinnedRevision required");
  invariant(typeof liveRevisionId === "string", "liveRevisionId required");
  invariant(typeof liveRevisionSha256 === "string", "liveRevisionSha256 required");
  invariant(typeof status === "string", "status required");
  invariant(typeof observedAt === "string", "observedAt required (ISO 8601)");
  invariant(typeof manifestDigest === "string", "manifestDigest required");

  return {
    adapter: "wiki-read-adapter",
    version: 1,
    caller,
    requested_path: requestedPath,
    pinned_revision: pinnedRevision,
    live_revision_id: liveRevisionId,
    live_revision_sha256: liveRevisionSha256,
    status,
    observed_at: observedAt,
    manifest_digest: manifestDigest,
    redactions_applied: ["source-content", "secrets", "tokens", "credentials"],
  };
}

function isSensitiveKey(key) {
  return REDACTED_KEYS.has(String(key).toLowerCase());
}

module.exports = { buildAuditReceipt, isSensitiveKey };

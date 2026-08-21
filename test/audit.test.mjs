import assert from "node:assert/strict";
import test from "node:test";

import { buildAuditReceipt, isSensitiveKey } from "../src/audit.js";

test("buildAuditReceipt emits exactly the required fields, none of which are source content", () => {
  const r = buildAuditReceipt({
    caller: "lexi",
    requestedPath: "/agents/lexi",
    pinnedRevision: "rev_abc",
    liveRevisionId: "rev_abc",
    liveRevisionSha256: "a".repeat(64),
    status: "ok",
    observedAt: "2026-08-21T02:00:00.000Z",
    manifestDigest: "b".repeat(64),
  });
  assert.equal(r.adapter, "wiki-read-adapter");
  assert.equal(r.version, 1);
  assert.equal(r.caller, "lexi");
  assert.equal(r.requested_path, "/agents/lexi");
  assert.equal(r.pinned_revision, "rev_abc");
  assert.equal(r.live_revision_id, "rev_abc");
  assert.equal(r.live_revision_sha256, "a".repeat(64));
  assert.equal(r.status, "ok");
  assert.equal(r.observed_at, "2026-08-21T02:00:00.000Z");
  assert.equal(r.manifest_digest, "b".repeat(64));
  assert.deepEqual(r.redactions_applied, ["source-content", "secrets", "tokens", "credentials"]);
  // Defensive: none of the canonical leak keys are present.
  for (const k of ["content", "body", "raw", "token", "secret", "credential", "password"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(r, k), false, `audit receipt must not contain ${k}`);
  }
});

test("isSensitiveKey identifies leak keys", () => {
  assert.equal(isSensitiveKey("content"), true);
  assert.equal(isSensitiveKey("token"), true);
  assert.equal(isSensitiveKey("SECRET"), true);
  assert.equal(isSensitiveKey("credentials"), true);
  assert.equal(isSensitiveKey("caller"), false);
  assert.equal(isSensitiveKey("revision_id"), false);
});

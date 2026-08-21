import assert from "node:assert/strict";
import test from "node:test";

import { verifyPinnedRevision, hashContent, normalizeCanonicalPath } from "../src/pinned-revision.js";

const SHA = "a".repeat(64);

test("hashContent produces a stable SHA-256", () => {
  const h1 = hashContent("hello world");
  const h2 = hashContent("hello world");
  assert.equal(h1, h2);
  assert.match(h1, /^[a-f0-9]{64}$/);
});

test("normalizeCanonicalPath extracts the path component", () => {
  assert.equal(normalizeCanonicalPath("https://wiki.tantaholdings.com/agents/lexi"), "/agents/lexi");
});

test("verifyPinnedRevision passes when path + revision + sha256 all match", () => {
  const v = verifyPinnedRevision({
    response: {
      canonical_url: "https://wiki.tantaholdings.com/agents/lexi",
      revision_id: "rev_123",
      revision_sha256: SHA,
    },
    requestedPath: "/agents/lexi",
    pinnedRevision: "rev_123",
    pinnedSha256: SHA,
  });
  assert.equal(v.revision_id, "rev_123");
  assert.equal(v.revision_sha256, SHA);
});

test("verifyPinnedRevision fails closed on provenance mismatch (wrong canonical path)", () => {
  assert.throws(
    () =>
      verifyPinnedRevision({
        response: {
          canonical_url: "https://wiki.tantaholdings.com/agents/mikasa",
          revision_id: "rev_123",
          revision_sha256: SHA,
        },
        requestedPath: "/agents/lexi",
        pinnedRevision: "rev_123",
        pinnedSha256: SHA,
      }),
    (err) => err.code === "provenance_mismatch",
  );
});

test("verifyPinnedRevision fails closed on revision mismatch", () => {
  assert.throws(
    () =>
      verifyPinnedRevision({
        response: {
          canonical_url: "https://wiki.tantaholdings.com/agents/lexi",
          revision_id: "rev_999",
          revision_sha256: SHA,
        },
        requestedPath: "/agents/lexi",
        pinnedRevision: "rev_123",
      }),
    (err) => err.code === "revision_mismatch",
  );
});

test("verifyPinnedRevision fails closed on sha256 mismatch", () => {
  assert.throws(
    () =>
      verifyPinnedRevision({
        response: {
          canonical_url: "https://wiki.tantaholdings.com/agents/lexi",
          revision_id: "rev_123",
          revision_sha256: SHA,
        },
        requestedPath: "/agents/lexi",
        pinnedRevision: "rev_123",
        pinnedSha256: "b".repeat(64),
      }),
    (err) => err.code === "sha256_mismatch",
  );
});

test("verifyPinnedRevision fails closed when canonical_url is missing", () => {
  assert.throws(
    () =>
      verifyPinnedRevision({
        response: { revision_id: "rev_123", revision_sha256: SHA },
        requestedPath: "/agents/lexi",
        pinnedRevision: "rev_123",
      }),
    /canonical_url missing/,
  );
});

test("verifyPinnedRevision fails closed when revision_sha256 is not 64-char hex", () => {
  assert.throws(
    () =>
      verifyPinnedRevision({
        response: {
          canonical_url: "https://wiki.tantaholdings.com/agents/lexi",
          revision_id: "rev_123",
          revision_sha256: "not-hex",
        },
        requestedPath: "/agents/lexi",
        pinnedRevision: "rev_123",
      }),
    /revision_sha256 must be 64-char hex/,
  );
});

test("verifyPinnedRevision fails closed when expectedPath differs from canonical", () => {
  assert.throws(
    () =>
      verifyPinnedRevision({
        response: {
          canonical_url: "https://wiki.tantaholdings.com/agents/lexi",
          revision_id: "rev_123",
          revision_sha256: SHA,
        },
        requestedPath: "/agents/lexi",
        pinnedRevision: "rev_123",
        expectedPath: "/agents/nanao",
      }),
    (err) => err.code === "pinned_path_mismatch",
  );
});

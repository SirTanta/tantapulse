import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { readCanonicalPage } from "../src/orchestrator.js";
import { MANIFEST_FILENAME, SCHEMA } from "../src/manifest.js";

const VALID_MANIFEST = {
  $schema: SCHEMA,
  version: 1,
  purpose: "lexi-janice-tvp-academy-intake",
  adapter: "wiki-read-adapter",
  scope: "read-only",
  transport: "private-backend-api-only",
  fallback_forbidden: ["browser-automation", "browser-credentials", "human-user-login", "front-end-fetch", "local-worktree-read"],
  authorized_profile: "lexi",
  authorized_paths: ["/agents/lexi", "/agents/nanao", "/docs/contracts/backend-only-wiki-access"],
  forbidden_paths: ["/agents/mikasa", "/docs/contracts/wiki-write-service", "/docs/incidents"],
  pinned_revision_required: true,
  pinned_revision_default: "da9336f6d3ad456f5b8065e6b8fc53ce7a6ba989",
  response_required_fields: ["canonical_url", "revision_id", "revision_sha256"],
  audit_receipt_required: true,
  audit_receipt_redactions: ["source-content", "secrets", "tokens", "credentials"],
  credential_resolution: "infisical-central-only",
  credential_env_keys: ["WIKI_READ_ADAPTER_BASE_URL", "WIKI_READ_ADAPTER_API_TOKEN"],
  write_capability: "none",
  atlas_write_capability: "none",
  ticket_creation_capability: "none",
  gateway_control_capability: "none",
  public_access_capability: "none",
};

const VALID_ENV = {
  WIKI_READ_ADAPTER_BASE_URL: "https://wiki.tantaholdings.com",
  WIKI_READ_ADAPTER_API_TOKEN: "test-token-1234567890abcdef",
};

const PINNED_REVISION = "da9336f6d3ad456f5b8065e6b8fc53ce7a6ba989";
const PINNED_SHA = "a".repeat(64);

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-read-adapter-orch-"));
  fs.writeFileSync(path.join(dir, MANIFEST_FILENAME), JSON.stringify(VALID_MANIFEST));
  return dir;
}

function successResponse(canonical_url = "https://wiki.tantaholdings.com/agents/lexi", revisionId = PINNED_REVISION, sha = PINNED_SHA) {
  return new Response(JSON.stringify({ canonical_url, revision_id: revisionId, revision_sha256: sha }), { status: 200 });
}

test("positive: Lexi reads the pinned /agents/lexi canonical page and returns URL/revision/sha256 + audit receipt", async () => {
  const fakeFetch = async () => successResponse();
  const result = await readCanonicalPage({
    caller: "lexi",
    requestedPath: "/agents/lexi",
    pinnedRevision: PINNED_REVISION,
    expectedPath: "/agents/lexi",
    env: VALID_ENV,
    manifest: VALID_MANIFEST,
    fetchImpl: fakeFetch,
    now: () => "2026-08-21T02:00:00.000Z",
  });
  assert.equal(result.verified.canonical_url, "https://wiki.tantaholdings.com/agents/lexi");
  assert.equal(result.verified.revision_id, PINNED_REVISION);
  assert.equal(result.verified.revision_sha256, PINNED_SHA);
  assert.equal(result.audit_receipt.caller, "lexi");
  assert.equal(result.audit_receipt.pinned_revision, PINNED_REVISION);
  assert.equal(result.audit_receipt.status, "ok");
  assert.equal(result.audit_receipt.observed_at, "2026-08-21T02:00:00.000Z");
  assert.match(result.audit_receipt.manifest_digest, /^[a-f0-9]{64}$/);
});

test("positive: defaults to the manifest's pinned_revision_default when no override is supplied", async () => {
  let capturedRevision = null;
  const fakeFetch = async (url, options) => {
    capturedRevision = options.headers["x-tanta-wiki-pinned-revision"];
    return successResponse();
  };
  const result = await readCanonicalPage({
    caller: "lexi",
    requestedPath: "/agents/lexi",
    env: VALID_ENV,
    manifest: VALID_MANIFEST,
    fetchImpl: fakeFetch,
    now: () => "2026-08-21T02:00:00.000Z",
  });
  assert.equal(capturedRevision, VALID_MANIFEST.pinned_revision_default);
  assert.equal(result.verified.revision_id, VALID_MANIFEST.pinned_revision_default);
});

test("negative: unauthorized profile is rejected before any HTTP call", async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return successResponse();
  };
  await assert.rejects(
    () =>
      readCanonicalPage({
        caller: "mikasa",
        requestedPath: "/agents/lexi",
        env: VALID_ENV,
        manifest: VALID_MANIFEST,
        fetchImpl: fakeFetch,
      }),
    (err) => err.code === "unauthorized_profile",
  );
  assert.equal(called, false, "must not call the backend on unauthorized_profile");
});

test("negative: unauthorized path is rejected before any HTTP call", async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return successResponse();
  };
  await assert.rejects(
    () =>
      readCanonicalPage({
        caller: "lexi",
        requestedPath: "/agents/cc",
        env: VALID_ENV,
        manifest: VALID_MANIFEST,
        fetchImpl: fakeFetch,
      }),
    (err) => err.code === "unauthorized_path",
  );
  assert.equal(called, false);
});

test("negative: forbidden path (wiki-write-service) is rejected even though profile is authorized", async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return successResponse();
  };
  await assert.rejects(
    () =>
      readCanonicalPage({
        caller: "lexi",
        requestedPath: "/docs/contracts/wiki-write-service",
        env: VALID_ENV,
        manifest: VALID_MANIFEST,
        fetchImpl: fakeFetch,
      }),
    (err) => err.code === "forbidden_path",
  );
  assert.equal(called, false);
});

test("negative: mismatched revision (live revision_id differs from pinned) is fail-closed", async () => {
  const fakeFetch = async () => successResponse("https://wiki.tantaholdings.com/agents/lexi", "rev_live_999", PINNED_SHA);
  await assert.rejects(
    () =>
      readCanonicalPage({
        caller: "lexi",
        requestedPath: "/agents/lexi",
        pinnedRevision: PINNED_REVISION,
        env: VALID_ENV,
        manifest: VALID_MANIFEST,
        fetchImpl: fakeFetch,
      }),
    (err) => err.code === "revision_mismatch",
  );
});

test("negative: mismatched SHA-256 is fail-closed", async () => {
  const fakeFetch = async () => successResponse("https://wiki.tantaholdings.com/agents/lexi", PINNED_REVISION, "b".repeat(64));
  await assert.rejects(
    () =>
      readCanonicalPage({
        caller: "lexi",
        requestedPath: "/agents/lexi",
        pinnedRevision: PINNED_REVISION,
        pinnedSha256: PINNED_SHA,
        env: VALID_ENV,
        manifest: VALID_MANIFEST,
        fetchImpl: fakeFetch,
      }),
    (err) => err.code === "sha256_mismatch",
  );
});

test("negative: provenance mismatch (response canonical_url points at a different page) is fail-closed", async () => {
  const fakeFetch = async () => successResponse("https://wiki.tantaholdings.com/agents/mikasa", PINNED_REVISION, PINNED_SHA);
  await assert.rejects(
    () =>
      readCanonicalPage({
        caller: "lexi",
        requestedPath: "/agents/lexi",
        pinnedRevision: PINNED_REVISION,
        env: VALID_ENV,
        manifest: VALID_MANIFEST,
        fetchImpl: fakeFetch,
      }),
    (err) => err.code === "provenance_mismatch",
  );
});

test("negative: missing credentials fail closed with no HTTP call", async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return successResponse();
  };
  await assert.rejects(
    () =>
      readCanonicalPage({
        caller: "lexi",
        requestedPath: "/agents/lexi",
        env: { WIKI_READ_ADAPTER_BASE_URL: "https://wiki.tantaholdings.com" },
        manifest: VALID_MANIFEST,
        fetchImpl: fakeFetch,
      }),
    /WIKI_READ_ADAPTER_API_TOKEN/,
  );
  assert.equal(called, false);
});

test("end-to-end: the source-controlled manifest on disk loads and the pipeline succeeds for Lexi", async () => {
  // Switch CWD into the fixture so loadManifest(process.cwd()) finds the
  // manifest file. We then run with caller=lexi, authorized path.
  const dir = fixture();
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    const result = await readCanonicalPage({
      caller: "lexi",
      requestedPath: "/agents/lexi",
      pinnedRevision: PINNED_REVISION,
      env: VALID_ENV,
      fetchImpl: async () => successResponse(),
      now: () => "2026-08-21T02:00:00.000Z",
    });
    assert.equal(result.verified.revision_id, PINNED_REVISION);
    assert.equal(result.audit_receipt.status, "ok");
  } finally {
    process.chdir(prevCwd);
  }
});

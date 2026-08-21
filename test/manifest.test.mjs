import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadManifest, manifestDigest, MANIFEST_FILENAME, SCHEMA } from "../src/manifest.js";

const FIXTURE_PATH = path.join(process.cwd(), HERMES_GOVERNED_WIKI_ASSIGNMENT_MANIFEST_V1());

function HERMES_GOVERNED_WIKI_ASSIGNMENT_MANIFEST_V1() {
  return MANIFEST_FILENAME;
}

const VALID = {
  $schema: SCHEMA,
  version: 1,
  purpose: "lexi-janice-tvp-academy-intake",
  adapter: "wiki-read-adapter",
  scope: "read-only",
  transport: "private-backend-api-only",
  fallback_forbidden: ["browser-automation", "browser-credentials", "human-user-login", "front-end-fetch", "local-worktree-read"],
  authorized_profile: "lexi",
  authorized_paths: ["/agents/lexi", "/agents/nanao", "/docs/contracts/backend-only-wiki-access"],
  forbidden_paths: ["/agents/*", "/docs/contracts/wiki-write-service", "/docs/incidents/*"],
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

function withManifest(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-read-adapter-"));
  const file = path.join(dir, MANIFEST_FILENAME);
  fs.writeFileSync(file, JSON.stringify({ ...VALID, ...extra }));
  return dir;
}

test("loads the source-controlled manifest and confirms the read-only invariants", () => {
  const dir = withManifest();
  const m = loadManifest(dir);
  assert.equal(m.authorized_profile, "lexi");
  assert.equal(m.scope, "read-only");
  assert.equal(m.transport, "private-backend-api-only");
  assert.equal(m.write_capability, "none");
  assert.equal(m.atlas_write_capability, "none");
  assert.equal(m.ticket_creation_capability, "none");
  assert.equal(m.gateway_control_capability, "none");
  assert.equal(m.public_access_capability, "none");
});

test("manifest digest is deterministic", () => {
  const a = manifestDigest(VALID);
  const b = manifestDigest(VALID);
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test("rejects a write-capable manifest (defense in depth)", () => {
  const dir = withManifest({ write_capability: "lexi" });
  assert.throws(() => loadManifest(dir), /write_capability must be none/);
});

test("rejects a manifest that omits the required response fields", () => {
  const dir = withManifest({ response_required_fields: ["canonical_url"] });
  assert.throws(() => loadManifest(dir), /response_required_fields must include/);
});

test("rejects a manifest that allows local-worktree-read fallback", () => {
  const dir = withManifest({ fallback_forbidden: ["browser-automation"] });
  assert.throws(() => loadManifest(dir), /fallback_forbidden must include/);
});

test("rejects a manifest whose credential resolution is not infisical-central-only", () => {
  const dir = withManifest({ credential_resolution: "env-anywhere" });
  assert.throws(() => loadManifest(dir), /credential_resolution must be/);
});

test("rejects an unknown schema", () => {
  const dir = withManifest({ $schema: "HERMES_GOVERNED_WIKI_ASSIGNMENT_MANIFEST_V2" });
  assert.throws(() => loadManifest(dir), /\$schema must be/);
});

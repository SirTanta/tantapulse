"use strict";

/**
 * manifest.js — load + validate the source-controlled assignment manifest.
 *
 * The manifest is the only authority that authorizes a profile to call the
 * private backend, and it is the only authority that defines the authorized
 * and forbidden paths. Any drift from the manifest fails closed.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MANIFEST_FILENAME = "HERMES_GOVERNED_WIKI_ASSIGNMENT_MANIFEST_V1.json";
const SCHEMA = "HERMES_GOVERNED_WIKI_ASSIGNMENT_MANIFEST_V1";

function invariant(condition, message) {
  if (!condition) throw new Error(`manifest: ${message}`);
}

function loadManifest(rootDir = process.cwd()) {
  const filePath = path.join(rootDir, MANIFEST_FILENAME);
  invariant(fs.existsSync(filePath), `missing ${MANIFEST_FILENAME} at ${filePath}`);
  const raw = fs.readFileSync(filePath, "utf8");
  const m = JSON.parse(raw);
  invariant(m.$schema === SCHEMA, `$schema must be ${SCHEMA}, got ${m.$schema}`);
  invariant(m.scope === "read-only", `scope must be read-only, got ${m.scope}`);
  invariant(m.transport === "private-backend-api-only", `transport must be private-backend-api-only`);
  invariant(m.adapter === "wiki-read-adapter", `adapter must be wiki-read-adapter`);
  invariant(m.authorized_profile === "lexi", `authorized_profile must be lexi`);
  invariant(m.write_capability === "none", "write_capability must be none");
  invariant(m.atlas_write_capability === "none", "atlas_write_capability must be none");
  invariant(m.ticket_creation_capability === "none", "ticket_creation_capability must be none");
  invariant(m.gateway_control_capability === "none", "gateway_control_capability must be none");
  invariant(m.public_access_capability === "none", "public_access_capability must be none");
  invariant(typeof m.pinned_revision_required === "boolean", "pinned_revision_required must be boolean");
  invariant(typeof m.pinned_revision_default === "string" && /^[a-f0-9]{40}$/.test(m.pinned_revision_default), "pinned_revision_default must be a 40-char SHA-1 / hex SHA-256 prefix");
  invariant(m.credential_resolution === "infisical-central-only", `credential_resolution must be infisical-central-only, got ${m.credential_resolution}`);
  invariant(Array.isArray(m.authorized_paths) && m.authorized_paths.length > 0, "authorized_paths must be a non-empty array");
  invariant(Array.isArray(m.forbidden_paths) && m.forbidden_paths.length > 0, "forbidden_paths must be a non-empty array");
  invariant(Array.isArray(m.response_required_fields) && m.response_required_fields.includes("canonical_url") && m.response_required_fields.includes("revision_id") && m.response_required_fields.includes("revision_sha256"), "response_required_fields must include canonical_url, revision_id, revision_sha256");
  invariant(Array.isArray(m.credential_env_keys) && m.credential_env_keys.includes("WIKI_READ_ADAPTER_BASE_URL") && m.credential_env_keys.includes("WIKI_READ_ADAPTER_API_TOKEN"), "credential_env_keys must include WIKI_READ_ADAPTER_BASE_URL and WIKI_READ_ADAPTER_API_TOKEN");
  invariant(Array.isArray(m.audit_receipt_redactions) && m.audit_receipt_redactions.includes("source-content") && m.audit_receipt_redactions.includes("secrets"), "audit_receipt_redactions must include source-content and secrets");
  invariant(Array.isArray(m.fallback_forbidden) && m.fallback_forbidden.includes("browser-automation") && m.fallback_forbidden.includes("local-worktree-read"), "fallback_forbidden must include browser-automation and local-worktree-read");
  return m;
}

function manifestDigest(manifest) {
  // Re-serialize deterministically so the manifest itself can be referenced by hash
  return crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

module.exports = { loadManifest, manifestDigest, MANIFEST_FILENAME, SCHEMA };

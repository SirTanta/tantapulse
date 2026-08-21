"use strict";

/**
 * orchestrator.js — wire manifest + credential + authorize + fetch +
 * pinned-revision + audit into one read-only pipeline.
 *
 * No HTTP side effects happen unless the caller passes authorize() and the
 * manifest validates. The function is deterministic given a fetchImpl.
 */

const { loadManifest, manifestDigest } = require("./manifest.js");
const { resolveCredentials } = require("./credential.js");
const { authorize } = require("./authorize.js");
const { fetchCanonicalPage } = require("./fetch.js");
const { verifyPinnedRevision } = require("./pinned-revision.js");
const { buildAuditReceipt } = require("./audit.js");

async function readCanonicalPage({
  caller,
  requestedPath,
  pinnedRevision,
  pinnedSha256,
  expectedPath,
  env = process.env,
  manifest,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
}) {
  const m = manifest || loadManifest(process.cwd());
  const { baseUrl, token } = resolveCredentials(env, ["WIKI_READ_ADAPTER_BASE_URL", "WIKI_READ_ADAPTER_API_TOKEN"]);
  authorize(caller, requestedPath, m);

  const response = await fetchCanonicalPage({ baseUrl, token, path: requestedPath, pinnedRevision: pinnedRevision || m.pinned_revision_default, fetchImpl });
  const verified = verifyPinnedRevision({ response, requestedPath, pinnedRevision: pinnedRevision || m.pinned_revision_default, pinnedSha256, expectedPath });

  const receipt = buildAuditReceipt({
    caller,
    requestedPath,
    pinnedRevision: pinnedRevision || m.pinned_revision_default,
    liveRevisionId: verified.revision_id,
    liveRevisionSha256: verified.revision_sha256,
    status: "ok",
    observedAt: now(),
    manifestDigest: manifestDigest(m),
  });

  return { verified, audit_receipt: receipt };
}

module.exports = { readCanonicalPage };

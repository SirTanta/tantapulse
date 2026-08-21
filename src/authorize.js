"use strict";

/**
 * authorize.js — verify the caller profile and the requested path are
 * authorized under the assignment manifest.
 *
 * Lexi is the only authorized profile. The path must exactly match one of the
 * allow-list entries OR be a sub-path under one of the prefixes that begins
 * with the allow-list entry. The forbidden paths are checked first; any hit
 * is a fail-closed denial regardless of allow-list overlap.
 */

function invariant(condition, message) {
  if (!condition) throw new Error(`authorize: ${message}`);
}

function matchesAny(haystack, needle) {
  return haystack.some((p) => needle === p || needle.startsWith(p + "/"));
}

function authorize(caller, requestedPath, manifest) {
  invariant(typeof caller === "string" && caller.length > 0, "caller required");
  invariant(typeof requestedPath === "string" && requestedPath.startsWith("/"), "path must start with /");
  invariant(manifest && manifest.$schema, "manifest required");

  // Profile gate: only `lexi` may invoke. No silent defaulting.
  if (caller !== manifest.authorized_profile) {
    const err = new Error(`unauthorized_profile: caller=${caller} required=${manifest.authorized_profile}`);
    err.code = "unauthorized_profile";
    throw err;
  }

  // Deny-list takes precedence over allow-list.
  if (matchesAny(manifest.forbidden_paths, requestedPath)) {
    const err = new Error(`forbidden_path: ${requestedPath}`);
    err.code = "forbidden_path";
    throw err;
  }

  if (!matchesAny(manifest.authorized_paths, requestedPath)) {
    const err = new Error(`unauthorized_path: ${requestedPath}`);
    err.code = "unauthorized_path";
    throw err;
  }

  return { caller, path: requestedPath, manifestRevision: manifest.pinned_revision_default };
}

module.exports = { authorize, matchesAny };

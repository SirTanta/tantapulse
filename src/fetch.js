"use strict";

/**
 * fetch.js — call the private backend with the required auth + revision
 * header. The transport is strictly the private backend URL resolved from
 * the env (no browser, no local worktree, no public fallback).
 */

function invariant(condition, message) {
  if (!condition) throw new Error(`fetch: ${message}`);
}

function buildHeaders(token, pinnedRevision) {
  invariant(typeof token === "string" && token.length > 0, "token required");
  invariant(typeof pinnedRevision === "string" && pinnedRevision.length > 0, "pinned revision required");
  return {
    "authorization": `Bearer ${token}`,
    "x-tanta-wiki-pinned-revision": pinnedRevision,
    "x-tanta-wiki-read-only": "1",
    "x-tanta-wiki-adapter": "wiki-read-adapter",
    "accept": "application/json",
  };
}

async function fetchCanonicalPage({ baseUrl, token, path, pinnedRevision, fetchImpl = fetch }) {
  invariant(typeof baseUrl === "string" && baseUrl.length > 0, "baseUrl required");
  invariant(typeof path === "string" && path.startsWith("/"), "path required");

  const url = `${baseUrl}/api/wiki/read${path}`;
  const response = await fetchImpl(url, { method: "GET", headers: buildHeaders(token, pinnedRevision) });
  if (!response.ok) {
    const err = new Error(`backend_http_${response.status}: ${path}`);
    err.code = "backend_http_error";
    err.status = response.status;
    throw err;
  }
  const body = await response.json();
  return body;
}

module.exports = { fetchCanonicalPage, buildHeaders };

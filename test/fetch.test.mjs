import assert from "node:assert/strict";
import test from "node:test";

import { fetchCanonicalPage, buildHeaders } from "../src/fetch.js";

test("buildHeaders always sets the pinned-revision + read-only + adapter headers", () => {
  const h = buildHeaders("token-1234567890", "rev_abc");
  assert.equal(h.authorization, "Bearer token-1234567890");
  assert.equal(h["x-tanta-wiki-pinned-revision"], "rev_abc");
  assert.equal(h["x-tanta-wiki-read-only"], "1");
  assert.equal(h["x-tanta-wiki-adapter"], "wiki-read-adapter");
  assert.equal(h.accept, "application/json");
});

test("fetchCanonicalPage calls the private backend with the expected URL + headers", async () => {
  const seen = [];
  const fakeFetch = async (url, options) => {
    seen.push({ url, options });
    return new Response(
      JSON.stringify({
        canonical_url: "https://wiki.tantaholdings.com/agents/lexi",
        revision_id: "rev_abc",
        revision_sha256: "a".repeat(64),
      }),
      { status: 200 },
    );
  };
  const body = await fetchCanonicalPage({
    baseUrl: "https://wiki.tantaholdings.com",
    token: "token-1234567890",
    path: "/agents/lexi",
    pinnedRevision: "rev_abc",
    fetchImpl: fakeFetch,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://wiki.tantaholdings.com/api/wiki/read/agents/lexi");
  assert.equal(seen[0].options.method, "GET");
  assert.equal(seen[0].options.headers["x-tanta-wiki-pinned-revision"], "rev_abc");
  assert.equal(body.revision_id, "rev_abc");
});

test("fetchCanonicalPage surfaces backend HTTP errors with code backend_http_error", async () => {
  const fakeFetch = async () => new Response("nope", { status: 502 });
  await assert.rejects(
    () =>
      fetchCanonicalPage({
        baseUrl: "https://wiki.tantaholdings.com",
        token: "token-1234567890",
        path: "/agents/lexi",
        pinnedRevision: "rev_abc",
        fetchImpl: fakeFetch,
      }),
    (err) => err.code === "backend_http_error" && err.status === 502,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { resolveCredentials } from "../src/credential.js";

test("resolves credentials from the central env bindings", () => {
  const env = {
    WIKI_READ_ADAPTER_BASE_URL: "https://wiki.tantaholdings.com/",
    WIKI_READ_ADAPTER_API_TOKEN: "test-token-1234567890",
  };
  const creds = resolveCredentials(env);
  assert.equal(creds.baseUrl, "https://wiki.tantaholdings.com");
  assert.equal(creds.token, "test-token-1234567890");
  assert.equal(creds.redacted.token, "REDACTED");
});

test("fails closed when the base URL env binding is missing", () => {
  assert.throws(() => resolveCredentials({ WIKI_READ_ADAPTER_API_TOKEN: "x".repeat(40) }), /WIKI_READ_ADAPTER_BASE_URL/);
});

test("fails closed when the API token env binding is missing", () => {
  assert.throws(() => resolveCredentials({ WIKI_READ_ADAPTER_BASE_URL: "https://wiki.tantaholdings.com" }), /WIKI_READ_ADAPTER_API_TOKEN/);
});

test("fails closed when the API token is shorter than the minimum length", () => {
  assert.throws(() => resolveCredentials({ WIKI_READ_ADAPTER_BASE_URL: "https://wiki.tantaholdings.com", WIKI_READ_ADAPTER_API_TOKEN: "short" }), /WIKI_READ_ADAPTER_API_TOKEN/);
});

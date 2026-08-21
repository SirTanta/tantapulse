import assert from "node:assert/strict";
import test from "node:test";

import { authorize, matchesAny } from "../src/authorize.js";

const MANIFEST = {
  $schema: "HERMES_GOVERNED_WIKI_ASSIGNMENT_MANIFEST_V1",
  authorized_profile: "lexi",
  authorized_paths: ["/agents/lexi", "/agents/nanao", "/agents/janice", "/docs/contracts/backend-only-wiki-access"],
  forbidden_paths: ["/agents/mikasa", "/docs/contracts/wiki-write-service", "/docs/incidents"],
  pinned_revision_default: "da9336f6d3ad456f5b8065e6b8fc53ce7a6ba989",
};

test("matchesAny treats slash-boundary prefixes correctly", () => {
  assert.equal(matchesAny(["/agents/lexi"], "/agents/lexi"), true);
  assert.equal(matchesAny(["/agents/lexi"], "/agents/lexi/operations"), true);
  assert.equal(matchesAny(["/agents/lexi"], "/agents/leximanual"), false, "must not match a prefix that continues without a separator");
  assert.equal(matchesAny(["/agents/lexi"], "/agents/lexi-extra"), false);
});

test("authorizes Lexi on an authorized path", () => {
  const r = authorize("lexi", "/agents/lexi", MANIFEST);
  assert.equal(r.caller, "lexi");
  assert.equal(r.path, "/agents/lexi");
});

test("authorizes Lexi on an authorized sub-path", () => {
  const r = authorize("lexi", "/agents/lexi/operations/janice", MANIFEST);
  assert.equal(r.path, "/agents/lexi/operations/janice");
});

test("denies an unauthorized profile with code unauthorized_profile", () => {
  assert.throws(() => authorize("mikasa", "/agents/lexi", MANIFEST), (err) => err.code === "unauthorized_profile");
});

test("denies a forbidden path with code forbidden_path", () => {
  assert.throws(() => authorize("lexi", "/agents/mikasa", MANIFEST), (err) => err.code === "forbidden_path");
});

test("denies an unauthorized path with code unauthorized_path", () => {
  assert.throws(() => authorize("lexi", "/agents/cc", MANIFEST), (err) => err.code === "unauthorized_path");
});

test("deny-list beats allow-list when both would match (lexi on /docs/contracts/wiki-write-service)", () => {
  // Lexi is allowed to read /docs/contracts/* would normally be true, but
  // /docs/contracts/wiki-write-service is explicitly forbidden.
  assert.throws(
    () => authorize("lexi", "/docs/contracts/wiki-write-service", MANIFEST),
    (err) => err.code === "forbidden_path",
  );
});

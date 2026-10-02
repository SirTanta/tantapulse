import test from "node:test";
import assert from "node:assert/strict";
import { opsAlert, opsAlertSignature } from "../api/sample-intake/fulfill.js";

process.env.RESEND_API_KEY = "re_test";

function stubFetch({ listed, listOk = true }) {
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "POST") {
      sent.push(JSON.parse(init.body).subject);
      return { ok: true, json: async () => ({ id: "em_1" }) };
    }
    if (!listOk) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ data: listed }) };
  };
  return sent;
}

const lines = ["outreach: db PATCH leads 400: boom 12345"];
const subject = `[Pulse ops] fulfill errors [${opsAlertSignature(lines)}]`;

test("the same error is not emailed again inside the cooldown", async () => {
  const real = globalThis.fetch;
  const sent = stubFetch({ listed: [{ subject, created_at: new Date(Date.now() - 600000).toISOString() }] });
  try {
    await opsAlert("fulfill errors", lines, { cooldown: true });
    assert.equal(sent.length, 0);
  } finally {
    globalThis.fetch = real;
  }
});

test("a new error, or the same one after the cooldown, is emailed once", async () => {
  const real = globalThis.fetch;
  try {
    let sent = stubFetch({ listed: [{ subject, created_at: new Date(Date.now() - 7 * 3600000).toISOString() }] });
    await opsAlert("fulfill errors", lines, { cooldown: true });
    assert.deepEqual(sent, [subject]);
    sent = stubFetch({ listed: [{ subject, created_at: new Date().toISOString() }] });
    await opsAlert("fulfill errors", ["a different failure"], { cooldown: true });
    assert.equal(sent.length, 1);
  } finally {
    globalThis.fetch = real;
  }
});

test("if the send log cannot be read the alert still goes out (fail open)", async () => {
  const real = globalThis.fetch;
  const sent = stubFetch({ listed: [], listOk: false });
  try {
    await opsAlert("fulfill errors", lines, { cooldown: true });
    assert.equal(sent.length, 1);
  } finally {
    globalThis.fetch = real;
  }
});

test("one-off notices without cooldown are never suppressed", async () => {
  const real = globalThis.fetch;
  const sent = stubFetch({ listed: [{ subject: "[Pulse ops] market check sent", created_at: new Date().toISOString() }] });
  try {
    await opsAlert("market check sent", ["to a@b.com"]);
    assert.deepEqual(sent, ["[Pulse ops] market check sent"]);
  } finally {
    globalThis.fetch = real;
  }
});

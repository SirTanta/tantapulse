import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOCK_REASONS,
  approvalIsWellFormed,
  evaluateApproval,
  evaluateProspectSend,
  evaluateStopConditions,
} from "../lib/hunter-atlas-gate.mjs";

const NOW = new Date("2026-08-04T12:00:00Z");

function approvalFixture(overrides = {}) {
  return {
    approval_id: "apr_001",
    hunter_list_id: "list_77",
    authorized_owner: "owner@tantaholdings.com",
    audience_description: "Austin roofing operators",
    legal_basis: "legitimate_interest",
    offer_version: "offer_v3",
    message_version: "msg_v2",
    run_starts_at: "2026-08-01T00:00:00Z",
    run_ends_at: "2026-08-08T00:00:00Z",
    send_cap: 100,
    stop_conditions: {},
    state: "approved",
    ...overrides,
  };
}

function prospectFixture(overrides = {}) {
  return {
    prospect_id: "hp_1001",
    hunter_list_id: "list_77",
    approval_id: "apr_001",
    verification_state: "verified",
    enrollment_state: "enrolled",
    suppression_decision: "allowed",
    ...overrides,
  };
}

test("an active approval inside its window and under cap authorizes a send", () => {
  const gate = evaluateApproval({ approval: approvalFixture(), now: NOW, sentCount: 12 });
  assert.deepEqual(gate, { allowed: true, reason: null });
});

test("every non-approved approval state blocks the send", () => {
  for (const [state, reason] of [
    ["paused", BLOCK_REASONS.APPROVAL_PAUSED],
    ["stopped", BLOCK_REASONS.APPROVAL_STOPPED],
    ["expired", BLOCK_REASONS.APPROVAL_EXPIRED],
  ]) {
    const gate = evaluateApproval({ approval: approvalFixture({ state }), now: NOW, sentCount: 0 });
    assert.equal(gate.allowed, false, `${state} must block`);
    assert.equal(gate.reason, reason);
  }
});

test("a missing approval fails closed rather than defaulting to allowed", () => {
  assert.deepEqual(evaluateApproval({ approval: null, now: NOW }), { allowed: false, reason: BLOCK_REASONS.APPROVAL_ABSENT });
  assert.deepEqual(evaluateApproval({ now: NOW }), { allowed: false, reason: BLOCK_REASONS.APPROVAL_ABSENT });
  assert.deepEqual(evaluateApproval({}), { allowed: false, reason: BLOCK_REASONS.APPROVAL_ABSENT });
});

test("an approval missing any mandatory field is treated as misconfigured", () => {
  const mandatory = ["approval_id", "hunter_list_id", "authorized_owner", "legal_basis", "offer_version", "message_version", "run_starts_at", "run_ends_at", "send_cap"];
  for (const field of mandatory) {
    const approval = approvalFixture();
    delete approval[field];
    assert.equal(approvalIsWellFormed(approval), false, `${field} must be mandatory`);
    const gate = evaluateApproval({ approval, now: NOW, sentCount: 0 });
    assert.equal(gate.allowed, false);
    assert.equal(gate.reason, BLOCK_REASONS.APPROVAL_MISCONFIGURED);
  }
});

test("an unrecognised approval state is misconfigured, never permissive", () => {
  const gate = evaluateApproval({ approval: approvalFixture({ state: "probably_fine" }), now: NOW });
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, BLOCK_REASONS.APPROVAL_MISCONFIGURED);
});

test("an inverted run window is misconfigured", () => {
  const approval = approvalFixture({ run_starts_at: "2026-08-08T00:00:00Z", run_ends_at: "2026-08-01T00:00:00Z" });
  assert.equal(evaluateApproval({ approval, now: NOW }).reason, BLOCK_REASONS.APPROVAL_MISCONFIGURED);
});

test("the run window is enforced at both ends", () => {
  const approval = approvalFixture();
  assert.equal(evaluateApproval({ approval, now: new Date("2026-07-31T23:59:59Z") }).reason, BLOCK_REASONS.APPROVAL_WINDOW_NOT_OPEN);
  assert.equal(evaluateApproval({ approval, now: new Date("2026-08-08T00:00:01Z") }).reason, BLOCK_REASONS.APPROVAL_EXPIRED);
  assert.equal(evaluateApproval({ approval, now: new Date("2026-08-08T00:00:00Z") }).allowed, true);
});

test("the cap blocks at the limit, not one send past it", () => {
  const approval = approvalFixture({ send_cap: 25 });
  assert.equal(evaluateApproval({ approval, now: NOW, sentCount: 24 }).allowed, true);
  assert.equal(evaluateApproval({ approval, now: NOW, sentCount: 25 }).reason, BLOCK_REASONS.APPROVAL_CAP_REACHED);
  assert.equal(evaluateApproval({ approval, now: NOW, sentCount: 4000 }).reason, BLOCK_REASONS.APPROVAL_CAP_REACHED);
});

test("a zero cap blocks every send", () => {
  const gate = evaluateApproval({ approval: approvalFixture({ send_cap: 0 }), now: NOW, sentCount: 0 });
  assert.equal(gate.reason, BLOCK_REASONS.APPROVAL_CAP_REACHED);
});

test("an unreadable send count is misconfigured rather than assumed to be zero", () => {
  const approval = approvalFixture();
  assert.equal(evaluateApproval({ approval, now: NOW, sentCount: "many" }).reason, BLOCK_REASONS.APPROVAL_MISCONFIGURED);
  assert.equal(evaluateApproval({ approval, now: NOW, sentCount: -1 }).reason, BLOCK_REASONS.APPROVAL_MISCONFIGURED);
});

test("a tripped stop condition halts the run and names the condition", () => {
  const approval = approvalFixture({ stop_conditions: { bounced: 5, opted_out: 10 } });
  assert.equal(evaluateApproval({ approval, now: NOW, sentCount: 0, metrics: { bounced: 4 } }).allowed, true);
  const gate = evaluateApproval({ approval, now: NOW, sentCount: 0, metrics: { bounced: 5 } });
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, "stop_condition:bounced");
  assert.equal(gate.detail.observed, 5);
  assert.equal(gate.detail.limit, 5);
});

test("an unreadable stop condition or metric halts the run instead of being skipped", () => {
  assert.equal(evaluateStopConditions({ bounced: "five" }, { bounced: 0 }).triggered, true);
  assert.equal(evaluateStopConditions({ bounced: 5 }, { bounced: "lots" }).triggered, true);
  assert.equal(evaluateStopConditions({}, {}).triggered, false);
  assert.equal(evaluateStopConditions(null, null).triggered, false);
});

test("a suppression blocks the send ahead of any approval evaluation", () => {
  const gate = evaluateProspectSend({
    approval: approvalFixture(),
    prospect: prospectFixture(),
    suppression: { prospect_id: "hp_1001", reason: "opt_out" },
    now: NOW,
    sentCount: 0,
  });
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, BLOCK_REASONS.SUPPRESSED);
  assert.equal(gate.detail.reason_code, "opt_out");
});

test("re-approving a list never clears an existing suppression", () => {
  const suppression = { prospect_id: "hp_1001", reason: "opt_out" };
  const paused = evaluateProspectSend({ approval: approvalFixture({ state: "paused" }), prospect: prospectFixture(), suppression, now: NOW });
  const resumed = evaluateProspectSend({ approval: approvalFixture({ state: "approved" }), prospect: prospectFixture(), suppression, now: NOW });
  assert.equal(paused.reason, BLOCK_REASONS.SUPPRESSED);
  assert.equal(resumed.reason, BLOCK_REASONS.SUPPRESSED);
});

test("a prospect flagged suppressed in its own state row is blocked too", () => {
  const gate = evaluateProspectSend({
    approval: approvalFixture(),
    prospect: prospectFixture({ suppression_decision: "suppressed" }),
    now: NOW,
  });
  assert.equal(gate.reason, BLOCK_REASONS.SUPPRESSED);
});

test("an unverified prospect is never admitted", () => {
  for (const state of ["unverified", "unverifiable", "rejected"]) {
    const gate = evaluateProspectSend({ approval: approvalFixture(), prospect: prospectFixture({ verification_state: state }), now: NOW });
    assert.equal(gate.reason, BLOCK_REASONS.PROSPECT_NOT_VERIFIED, `${state} must block`);
  }
  assert.equal(evaluateProspectSend({ approval: approvalFixture(), prospect: null, now: NOW }).reason, BLOCK_REASONS.PROSPECT_ABSENT);
});

test("a prospect belonging to a different approval or list cannot ride this approval", () => {
  const approval = approvalFixture();
  assert.equal(evaluateProspectSend({ approval, prospect: prospectFixture({ approval_id: "apr_999" }), now: NOW }).reason, BLOCK_REASONS.APPROVAL_MISMATCH);
  assert.equal(evaluateProspectSend({ approval, prospect: prospectFixture({ hunter_list_id: "list_other" }), now: NOW }).reason, BLOCK_REASONS.APPROVAL_MISMATCH);
});

test("a verified prospect under an active approval is authorized", () => {
  const gate = evaluateProspectSend({ approval: approvalFixture(), prospect: prospectFixture(), now: NOW, sentCount: 3 });
  assert.deepEqual(gate, { allowed: true, reason: null });
});

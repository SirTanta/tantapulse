// Fail-closed authorization gate for Hunter -> Atlas ingestion.
//
// Nothing in this module talks to Hunter, Atlas, or a browser. It answers one
// question from durable state the TantaPulse runtime already owns: is this
// prospect authorized right now. Every unknown, malformed or missing input
// resolves to "blocked" -- never to "allowed".

export const APPROVAL_STATES = Object.freeze(["approved", "paused", "stopped", "expired"]);

export const REQUIRED_APPROVAL_FIELDS = Object.freeze([
  "approval_id",
  "hunter_list_id",
  "authorized_owner",
  "legal_basis",
  "offer_version",
  "message_version",
  "run_starts_at",
  "run_ends_at",
  "send_cap",
  "state",
]);

export const BLOCK_REASONS = Object.freeze({
  SUPPRESSED: "suppressed",
  APPROVAL_ABSENT: "approval_absent",
  APPROVAL_MISCONFIGURED: "approval_misconfigured",
  APPROVAL_PAUSED: "approval_paused",
  APPROVAL_STOPPED: "approval_stopped",
  APPROVAL_EXPIRED: "approval_expired",
  APPROVAL_WINDOW_NOT_OPEN: "approval_window_not_open",
  APPROVAL_CAP_REACHED: "approval_cap_reached",
  PROSPECT_ABSENT: "prospect_absent",
  PROSPECT_NOT_VERIFIED: "prospect_not_verified",
  APPROVAL_MISMATCH: "approval_mismatch",
});

function blocked(reason, detail) {
  return detail === undefined
    ? { allowed: false, reason }
    : { allowed: false, reason, detail };
}

function timestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

export function approvalIsWellFormed(approval) {
  if (!approval || typeof approval !== "object") return false;
  for (const field of REQUIRED_APPROVAL_FIELDS) {
    const value = approval[field];
    if (value === null || value === undefined || value === "") return false;
  }
  if (!APPROVAL_STATES.includes(approval.state)) return false;
  if (!isPositiveInteger(Number(approval.send_cap))) return false;
  const startsAt = timestamp(approval.run_starts_at);
  const endsAt = timestamp(approval.run_ends_at);
  if (!startsAt || !endsAt || endsAt <= startsAt) return false;
  if (approval.stop_conditions !== undefined && approval.stop_conditions !== null) {
    if (typeof approval.stop_conditions !== "object" || Array.isArray(approval.stop_conditions)) return false;
  }
  return true;
}

// A stop condition is a numeric ceiling: the run halts once the observed metric
// reaches it. An unreadable condition halts the run rather than being ignored.
export function evaluateStopConditions(stopConditions = {}, metrics = {}) {
  for (const [name, threshold] of Object.entries(stopConditions ?? {})) {
    const limit = Number(threshold);
    if (!Number.isFinite(limit)) return { triggered: true, condition: name, reason: "unreadable_threshold" };
    const observed = Number(metrics?.[name] ?? 0);
    if (!Number.isFinite(observed)) return { triggered: true, condition: name, reason: "unreadable_metric" };
    if (observed >= limit) return { triggered: true, condition: name, observed, limit };
  }
  return { triggered: false, condition: null };
}

export function evaluateApproval({ approval, now = new Date(), sentCount = 0, metrics = {} } = {}) {
  if (approval === null || approval === undefined) return blocked(BLOCK_REASONS.APPROVAL_ABSENT);
  if (!approvalIsWellFormed(approval)) return blocked(BLOCK_REASONS.APPROVAL_MISCONFIGURED);

  if (approval.state === "paused") return blocked(BLOCK_REASONS.APPROVAL_PAUSED);
  if (approval.state === "stopped") return blocked(BLOCK_REASONS.APPROVAL_STOPPED);
  if (approval.state === "expired") return blocked(BLOCK_REASONS.APPROVAL_EXPIRED);

  const at = timestamp(now);
  if (!at) return blocked(BLOCK_REASONS.APPROVAL_MISCONFIGURED);
  if (at < timestamp(approval.run_starts_at)) return blocked(BLOCK_REASONS.APPROVAL_WINDOW_NOT_OPEN);
  if (at > timestamp(approval.run_ends_at)) return blocked(BLOCK_REASONS.APPROVAL_EXPIRED);

  const used = Number(sentCount);
  if (!Number.isFinite(used) || used < 0) return blocked(BLOCK_REASONS.APPROVAL_MISCONFIGURED);
  if (used >= Number(approval.send_cap)) return blocked(BLOCK_REASONS.APPROVAL_CAP_REACHED);

  const stop = evaluateStopConditions(approval.stop_conditions, metrics);
  if (stop.triggered) return blocked(`stop_condition:${stop.condition}`, stop);

  return { allowed: true, reason: null };
}

// Suppression is evaluated ahead of the approval so that resuming, extending or
// re-approving a list can never resurrect a suppressed prospect.
export function evaluateProspectSend({
  approval,
  prospect,
  suppression = null,
  now = new Date(),
  sentCount = 0,
  metrics = {},
} = {}) {
  if (suppression) return blocked(BLOCK_REASONS.SUPPRESSED, { reason_code: suppression.reason ?? null });

  if (!prospect || typeof prospect !== "object" || !prospect.prospect_id) {
    return blocked(BLOCK_REASONS.PROSPECT_ABSENT);
  }
  if (prospect.suppression_decision === "suppressed") {
    return blocked(BLOCK_REASONS.SUPPRESSED, { reason_code: "prospect_state" });
  }
  if (prospect.verification_state !== "verified") return blocked(BLOCK_REASONS.PROSPECT_NOT_VERIFIED);

  const approvalGate = evaluateApproval({ approval, now, sentCount, metrics });
  if (!approvalGate.allowed) return approvalGate;

  if (prospect.approval_id !== approval.approval_id) return blocked(BLOCK_REASONS.APPROVAL_MISMATCH);
  if (prospect.hunter_list_id !== approval.hunter_list_id) return blocked(BLOCK_REASONS.APPROVAL_MISMATCH);

  return { allowed: true, reason: null };
}

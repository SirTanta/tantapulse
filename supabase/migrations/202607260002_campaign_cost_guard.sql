-- Explicit, approved estimate used to stop admissions before a campaign's
-- variable-cost limit. This is a guardrail, not a billing or purchase action.

alter table public.tantapulse_campaign_approvals
  add column if not exists estimated_variable_cost_per_prospect_cents integer;

alter table public.tantapulse_campaign_approvals
  add column if not exists recipient_enrollment_approved boolean not null default false;

alter table public.tantapulse_prospect_state
  add column if not exists hunter_enrolled_at timestamptz;

alter table public.tantapulse_campaign_approvals
  add constraint tantapulse_campaign_cost_estimate_nonnegative
  check (estimated_variable_cost_per_prospect_cents is null or estimated_variable_cost_per_prospect_cents >= 0);

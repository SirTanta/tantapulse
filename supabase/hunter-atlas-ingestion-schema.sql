-- Hunter -> Atlas ingestion state owned by the TantaPulse server runtime.
-- Apply through the approved production Supabase SQL Editor before deploying.
--
-- Boundary: no row here is ever exposed to a browser. Hunter raw responses, list
-- exports and message bodies are NEVER stored in, or forwarded from, these tables.
-- Only the normalized lifecycle facts below cross the Atlas boundary.

create extension if not exists pgcrypto;

-- 1. List approval record -------------------------------------------------
-- An approval is the ONLY authorization to enroll or send. It is immutable in
-- its identifying columns; lifecycle changes move `state` only.
create table if not exists public.hunter_list_approvals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approval_id text not null unique,
  hunter_list_id text not null,
  authorized_owner text not null,
  audience_description text not null,
  legal_basis text not null,
  offer_version text not null,
  message_version text not null,
  run_starts_at timestamptz not null,
  run_ends_at timestamptz not null,
  send_cap integer not null check (send_cap >= 0),
  stop_conditions jsonb not null default '{}'::jsonb,
  state text not null default 'approved'
    check (state in ('approved', 'paused', 'stopped', 'expired')),
  state_changed_at timestamptz not null default now(),
  state_reason text,
  constraint hunter_list_approvals_window_ck check (run_ends_at > run_starts_at)
);

create index if not exists hunter_list_approvals_state_idx
  on public.hunter_list_approvals (state, run_ends_at desc);
create index if not exists hunter_list_approvals_list_idx
  on public.hunter_list_approvals (hunter_list_id);

-- 2. Prospect state -------------------------------------------------------
create table if not exists public.hunter_prospect_states (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  prospect_id text not null unique,
  hunter_list_id text not null,
  approval_id text not null references public.hunter_list_approvals (approval_id),
  verification_state text not null default 'unverified'
    check (verification_state in ('unverified', 'verified', 'unverifiable', 'rejected')),
  verified_at timestamptz,
  enrollment_state text not null default 'not_enrolled'
    check (enrollment_state in ('not_enrolled', 'enrolled', 'withdrawn')),
  enrolled_at timestamptz,
  suppression_decision text not null default 'allowed'
    check (suppression_decision in ('allowed', 'suppressed')),
  first_name text,
  last_name text,
  email text
);

create index if not exists hunter_prospect_states_approval_idx
  on public.hunter_prospect_states (approval_id, enrollment_state);
create index if not exists hunter_prospect_states_verification_idx
  on public.hunter_prospect_states (verification_state);

-- 3. Suppression record ---------------------------------------------------
-- Written BEFORE any further enrollment or send is considered. Resuming an
-- approval never clears a suppression: rows are insert-only and the runtime
-- reads them ahead of every approval evaluation.
create table if not exists public.hunter_suppressions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  prospect_id text not null unique,
  email text,
  reason text not null
    check (reason in ('opt_out', 'hard_bounce', 'complaint', 'manual_hard_stop', 'legal_hold')),
  source text not null default 'tantapulse-runtime',
  suppressed_at timestamptz not null default now(),
  notes text
);

create index if not exists hunter_suppressions_reason_idx
  on public.hunter_suppressions (reason, suppressed_at desc);

-- 4. Atlas delivery ledger ------------------------------------------------
-- One row per (prospect, confirmed outcome). `event_id` is generated once on
-- first claim and reused verbatim on every retry. `outcome_key` is immutable
-- and uniquely identifies the confirmed fact being reported to Atlas.
create table if not exists public.atlas_delivery_ledger (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  outcome_key text not null unique,
  event_id uuid not null unique default gen_random_uuid(),
  prospect_id text not null,
  approval_id text,
  event_type text not null
    check (event_type in ('prospect.verified', 'prospect.stage_changed', 'prospect.conversion_recorded')),
  lifecycle_stage text
    check (lifecycle_stage is null or lifecycle_stage in
      ('new', 'contacted', 'replied', 'bounced', 'opted_out', 'meeting_booked')),
  occurred_at timestamptz not null default now(),
  -- Contract fields only (reason / revenue / normalized prospect name+email),
  -- so a retry rebuilds a byte-identical envelope. Never raw Hunter data.
  normalized_payload jsonb not null default '{}'::jsonb,
  attempt_state text not null default 'pending'
    check (attempt_state in ('pending', 'delivered', 'retry_scheduled', 'operator_review', 'rejected')),
  attempts integer not null default 0 check (attempts >= 0),
  response_classification text,
  response_status integer,
  last_attempted_at timestamptz,
  delivered_at timestamptz
);

create index if not exists atlas_delivery_ledger_prospect_idx
  on public.atlas_delivery_ledger (prospect_id, event_type);
create index if not exists atlas_delivery_ledger_state_idx
  on public.atlas_delivery_ledger (attempt_state, last_attempted_at asc);

-- Atlas rejects a non-create event for an unknown lead, so the create event
-- for a prospect must be delivered before any later lifecycle event is sent.
create index if not exists atlas_delivery_ledger_create_idx
  on public.atlas_delivery_ledger (prospect_id)
  where event_type = 'prospect.verified' and attempt_state = 'delivered';

-- Cap accounting: a send is counted once its `contacted` event is delivered.
create index if not exists atlas_delivery_ledger_cap_idx
  on public.atlas_delivery_ledger (approval_id)
  where lifecycle_stage = 'contacted';

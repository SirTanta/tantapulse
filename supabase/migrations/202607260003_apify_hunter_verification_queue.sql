-- Campaign-scoped Apify-to-Hunter verification queue. No send is possible
-- here; enrollment remains protected by its own approval gate.

alter table public.tantapulse_campaign_approvals
  add column if not exists verification_approved boolean not null default false,
  add column if not exists verification_cap integer,
  add column if not exists source_filter_key text,
  add column if not exists source_run_id uuid;

alter table public.tantapulse_campaign_approvals
  add constraint tantapulse_campaign_verification_cap_positive
  check (verification_cap is null or verification_cap > 0);

create table if not exists public.tantapulse_verification_candidates (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null references public.tantapulse_campaign_approvals(id) on delete cascade,
  source_candidate_id text not null,
  source_filter_key text not null,
  source_table text not null,
  source_ref jsonb not null default '{}'::jsonb,
  email text not null,
  first_name text,
  last_name text,
  verification_status text not null default 'pending' check (verification_status in ('pending', 'verifying', 'valid', 'invalid', 'error')),
  hunter_status text,
  verification_score numeric,
  verified_at timestamptz,
  admitted_at timestamptz,
  attempt_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (approval_id, source_candidate_id)
);

create index if not exists tantapulse_verification_candidates_pending_idx
  on public.tantapulse_verification_candidates(approval_id, verification_status, created_at)
  where verification_status in ('pending', 'error');

alter table public.tantapulse_verification_candidates enable row level security;

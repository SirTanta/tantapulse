-- TantaPulse outbound lifecycle control plane. Additive and inactive until an
-- approved campaign record plus release-gated runtime configuration exist.

create extension if not exists pgcrypto;

create table if not exists public.tantapulse_campaign_approvals (
  id uuid primary key default gen_random_uuid(),
  campaign_id text not null unique,
  status text not null default 'draft' check (status in ('draft', 'approved', 'paused', 'stopped', 'expired')),
  sequence_id text,
  sender_account_id text,
  approved_list_id text,
  prospect_cap integer not null check (prospect_cap > 0),
  variable_cost_cap_cents integer not null check (variable_cost_cap_cents >= 0),
  approved_by text,
  approved_at timestamptz,
  expires_at timestamptz,
  stop_conditions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status <> 'approved') or (approved_by is not null and approved_at is not null and sequence_id is not null and sender_account_id is not null))
);

create table if not exists public.tantapulse_prospect_state (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null references public.tantapulse_campaign_approvals(id) on delete cascade,
  hunter_prospect_id text not null,
  verification_status text not null check (verification_status in ('valid', 'deliverable')),
  email text not null,
  crm_lead_created_at timestamptz,
  suppressed_at timestamptz,
  suppression_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (approval_id, hunter_prospect_id)
);

create table if not exists public.tantapulse_outbound_event_ledger (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null references public.tantapulse_campaign_approvals(id) on delete cascade,
  event_key text not null unique,
  crm_event_id uuid not null unique,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  atlas_status integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tantapulse_outbound_receipts (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid references public.tantapulse_campaign_approvals(id) on delete set null,
  mode text not null check (mode in ('disabled', 'no_send', 'read_only_health', 'read_only_reconciliation', 'error')),
  run_timestamp_utc timestamptz not null default now(),
  message_count integer not null default 0,
  emitted_count integer not null default 0,
  skipped_unadmitted_count integer not null default 0,
  sender_status text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tantapulse_prospect_state_admission_idx on public.tantapulse_prospect_state(approval_id, hunter_prospect_id) where suppressed_at is null;
create index if not exists tantapulse_outbound_event_ledger_pending_idx on public.tantapulse_outbound_event_ledger(status, created_at) where status in ('pending', 'failed');
create index if not exists tantapulse_outbound_receipts_approval_idx on public.tantapulse_outbound_receipts(approval_id, run_timestamp_utc desc);

alter table public.tantapulse_campaign_approvals enable row level security;
alter table public.tantapulse_prospect_state enable row level security;
alter table public.tantapulse_outbound_event_ledger enable row level security;
alter table public.tantapulse_outbound_receipts enable row level security;

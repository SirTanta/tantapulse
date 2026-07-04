-- Lane 2: HVAC companies in Austin TX
-- Lead-intelligence schema mirroring TantaPulse structure.
-- Apply after the TantaPulse schema is already in place.

create extension if not exists pgcrypto;

-- Lane 2: HVAC/Austin run tracker
create table if not exists public.lane2_feed_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'queued',
  -- 'queued' | 'processing' | 'processed' | 'capped' | 'failed'
  apify_run_id text,
  apify_dataset_id text,
  total_count integer not null default 0,
  unique_count integer not null default 0,
  high_count integer not null default 0,
  usable_count integer not null default 0,
  duplicate_rate numeric,
  summary jsonb not null default '{}'::jsonb,
  spend_check jsonb  -- budget check result at trigger time
);

-- Lane 2: raw scraped items before scoring
create table if not exists public.lane2_raw_items (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  run_id uuid references public.lane2_feed_runs(id) on delete cascade,
  apify_run_id text,
  apify_dataset_id text,
  payload jsonb not null,
  payload_hash text not null,
  collected_at timestamptz
);

create unique index if not exists lane2_raw_items_payload_hash_idx
  on public.lane2_raw_items (payload_hash);

-- Lane 2: scored + deduped leads
create table if not exists public.lane2_leads (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  run_id uuid references public.lane2_feed_runs(id) on delete cascade,
  canonical_entity_id text not null,
  duplicate_group_id text not null,
  business_name text,
  niche text default 'HVAC',
  city text default 'Austin',
  state text default 'TX',
  website text,
  phone text,
  email text,
  source text default 'apify',
  source_url text,
  collected_at timestamptz,
  lead_score integer not null default 0,
  score_band text not null default 'low',
  recommended_action text not null default 'hold',
  score_breakdown jsonb not null default '{}'::jsonb,
  score_reasons jsonb not null default '[]'::jsonb,
  source_confidence numeric,
  extraction_confidence numeric,
  -- Additional HVAC-specific signals
  services text[],           -- e.g. ['installation','repair','maintenance']
  serving_zips text[],       -- ZIP codes served
  years_in_business integer,
  licensing_info text,
  insurance_verified boolean default false,
  emergency_service boolean default false,
  hvac_type text             -- 'residential' | 'commercial' | 'both'
);

create unique index if not exists lane2_leads_run_entity_idx
  on public.lane2_leads (run_id, canonical_entity_id);

create index if not exists lane2_leads_run_id_idx on public.lane2_leads (run_id);
create index if not exists lane2_leads_duplicate_group_idx on public.lane2_leads (duplicate_group_id);
create index if not exists lane2_leads_score_idx on public.lane2_leads (lead_score desc);
create index if not exists lane2_leads_email_idx on public.lane2_leads (email) where email is not null;

-- Lane 2: follow-up sequence state
create table if not exists public.lane2_followup_queue (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  lead_id bigint references public.lane2_leads(id) on delete cascade,
  run_id uuid references public.lane2_feed_runs(id) on delete cascade,
  email text not null,
  business_name text,
  step integer not null default 0,
  -- 0: initial outreach
  -- 1: follow-up #1
  -- 2: follow-up #2
  -- 3: final nudge
  scheduled_for timestamptz not null default now(),
  sent_at timestamptz,
  resend_message_id text,
  status text not null default 'pending'
  -- 'pending' | 'sent' | 'failed' | 'bounced'
);

create index if not exists lane2_followup_queue_lead_id_idx on public.lane2_followup_queue (lead_id);
create index if not exists lane2_followup_queue_status_scheduled
  on public.lane2_followup_queue (status, scheduled_for);

-- Lane 2: spend tracking (updated each Apify run)
create table if not exists public.lane2_spend_log (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  run_id uuid references public.lane2_feed_runs(id) on delete set null,
  check_at timestamptz not null default now(),
  budget_current_usd numeric not null default 0,
  budget_cap_usd numeric not null default 0,
  estimated_task_cost_usd numeric,
  allowed boolean not null default false,
  reason text,
  apify_limits_response jsonb  -- raw API response for audit
);

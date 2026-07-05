-- Sales discovery unified registry
-- Apply after the existing lead-feed schema is in place.

create extension if not exists pgcrypto;

create table if not exists public.sales_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'queued',
  source_class text not null default 'manual',
  source_lane text not null default 'sales.discovery.generic',
  source_name text not null default 'sales-discovery',
  source_id text,
  source_url text,
  apify_run_id text,
  apify_dataset_id text,
  total_count integer not null default 0,
  unique_count integer not null default 0,
  high_count integer not null default 0,
  usable_count integer not null default 0,
  duplicate_rate numeric,
  summary jsonb not null default '{}'::jsonb,
  spend_check jsonb,
  error text
);

create index if not exists sales_discovery_runs_status_idx on public.sales_discovery_runs (status, requested_at asc);
create index if not exists sales_discovery_runs_source_lane_idx on public.sales_discovery_runs (source_lane);

create table if not exists public.sales_discovery_raw_items (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  run_id uuid references public.sales_discovery_runs(id) on delete cascade,
  source_lane text not null default 'sales.discovery.generic',
  source_class text not null default 'manual',
  source_name text not null default 'sales-discovery',
  source_id text,
  canonical_key text,
  payload jsonb not null,
  payload_hash text not null,
  collected_at timestamptz,
  observed_at timestamptz,
  status text not null default 'queued',
  failure_reason text
);

create unique index if not exists sales_discovery_raw_items_payload_hash_idx on public.sales_discovery_raw_items (payload_hash);
create index if not exists sales_discovery_raw_items_run_idx on public.sales_discovery_raw_items (run_id);
create index if not exists sales_discovery_raw_items_canonical_idx on public.sales_discovery_raw_items (canonical_key);

create table if not exists public.sales_discovery_candidates (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  run_id uuid references public.sales_discovery_runs(id) on delete set null,
  canonical_key text not null,
  canonical_key_strategy text,
  source_lane text not null,
  source_class text not null,
  source_name text not null,
  source_id text,
  title text,
  entity_name text,
  entity_type text default 'signal',
  geo text,
  url text,
  score integer not null default 0,
  signal_type text,
  collected_at timestamptz,
  observed_at timestamptz,
  owner_hint text,
  evidence text,
  payload_hash text not null,
  budget_tag text,
  contactability text,
  company_size text,
  industry text,
  trigger_reason text,
  confidence numeric,
  follow_up_due_at timestamptz,
  raw_ref jsonb,
  score_reasons jsonb not null default '[]'::jsonb,
  score_band text not null default 'low',
  filing_state text not null default 'ready',
  recommended_action text not null default 'keep',
  file_worthy boolean not null default false,
  provenance jsonb not null default '[]'::jsonb,
  source_lanes text[] not null default '{}'::text[],
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  merged_count integer not null default 1,
  filed_at timestamptz,
  downstream_ref text
);

create unique index if not exists sales_discovery_candidates_key_idx on public.sales_discovery_candidates (canonical_key);
create index if not exists sales_discovery_candidates_score_idx on public.sales_discovery_candidates (score desc);
create index if not exists sales_discovery_candidates_filing_idx on public.sales_discovery_candidates (filing_state, score desc);
create index if not exists sales_discovery_candidates_source_lane_idx on public.sales_discovery_candidates (source_lane);
create index if not exists sales_discovery_candidates_url_idx on public.sales_discovery_candidates (url);
create index if not exists sales_discovery_candidates_payload_idx on public.sales_discovery_candidates (payload_hash);

create table if not exists public.sales_discovery_dead_letters (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  run_id uuid references public.sales_discovery_runs(id) on delete cascade,
  canonical_key text,
  source_lane text,
  source_class text,
  failure_class text not null,
  reason text not null,
  attempts integer not null default 1,
  last_attempt_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

create index if not exists sales_discovery_dead_letters_run_idx on public.sales_discovery_dead_letters (run_id);
create index if not exists sales_discovery_dead_letters_class_idx on public.sales_discovery_dead_letters (failure_class, last_attempt_at desc);

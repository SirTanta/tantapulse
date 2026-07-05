-- Lane 3: Job Boards (Indeed + LinkedIn)
-- Lead-intelligence schema for job posting collection.
-- Mirrors Lane 2 structure with job-specific fields.
-- Apply after the TantaPulse schema is already in place.

create extension if not exists pgcrypto;

-- Lane 3: Job board feed run tracker
create table if not exists public.lane3_feed_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'queued',
  -- 'queued' | 'processing' | 'processed' | 'capped' | 'failed'
  source text not null,          -- 'indeed' | 'linkedin'
  keyword text not null,         -- the search keyword used
  apify_run_id text,
  apify_dataset_id text,
  total_count integer not null default 0,
  unique_count integer not null default 0,
  high_count integer not null default 0,
  usable_count integer not null default 0,
  duplicate_rate numeric,
  summary jsonb not null default '{}'::jsonb,
  spend_check jsonb               -- budget check result at trigger time
);

create index if not exists lane3_feed_runs_status_idx on public.lane3_feed_runs (status);
create index if not exists lane3_feed_runs_source_idx on public.lane3_feed_runs (source);
create index if not exists lane3_feed_runs_requested_idx on public.lane3_feed_runs (requested_at desc);

-- Lane 3: raw scraped items before scoring
create table if not exists public.lane3_raw_items (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  run_id uuid references public.lane3_feed_runs(id) on delete cascade,
  apify_run_id text,
  apify_dataset_id text,
  payload jsonb not null,
  payload_hash text not null,
  collected_at timestamptz
);

create unique index if not exists lane3_raw_items_payload_hash_idx
  on public.lane3_raw_items (payload_hash);

-- Lane 3: scored + deduped job listings
create table if not exists public.lane3_jobs (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  run_id uuid references public.lane3_feed_runs(id) on delete cascade,
  canonical_entity_id text not null,
  duplicate_group_id text not null,
  company_name text,
  job_title text,
  posting_url text,
  posting_date timestamptz,
  location text,
  salary text,
  source text not null default 'indeed',
  keyword text,                    -- the search keyword that matched this
  raw_snippet text,
  collected_at timestamptz,
  lead_score integer not null default 0,
  score_band text not null default 'low',
  recommended_action text not null default 'hold',
  score_breakdown jsonb not null default '{}'::jsonb,
  score_reasons jsonb not null default '[]'::jsonb,
  -- Job-specific fields
  workplace_type text,             -- 'Remote' | 'Hybrid' | 'On-site'
  job_level text,                  -- 'Senior' | 'Mid' | 'Entry' | 'Internship'
  company_url text,
  company_logo text
);

create unique index if not exists lane3_jobs_run_entity_idx
  on public.lane3_jobs (run_id, canonical_entity_id);

create index if not exists lane3_jobs_run_id_idx on public.lane3_jobs (run_id);
create index if not exists lane3_jobs_dup_group_idx on public.lane3_jobs (duplicate_group_id);
create index if not exists lane3_jobs_score_idx on public.lane3_jobs (lead_score desc);
create index if not exists lane3_jobs_source_idx on public.lane3_jobs (source);
create index if not exists lane3_jobs_company_idx on public.lane3_jobs (company_name);
create index if not exists lane3_jobs_keyword_idx on public.lane3_jobs (keyword);

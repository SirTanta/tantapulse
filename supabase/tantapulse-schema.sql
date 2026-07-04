-- Tanta Pulse lead-intelligence schema
-- Apply in Supabase before enabling the processor cron.

create extension if not exists pgcrypto;

create table if not exists public.lead_feed_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'queued',
  request_name text,
  request_email text,
  niche text,
  city text,
  cadence text,
  notes text,
  source text not null default 'apify',
  apify_run_id text,
  apify_dataset_id text,
  total_count integer not null default 0,
  unique_count integer not null default 0,
  high_count integer not null default 0,
  usable_count integer not null default 0,
  duplicate_rate numeric,
  summary jsonb not null default '{}'::jsonb
);

create table if not exists public.lead_feed_raw_items (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  run_id uuid references public.lead_feed_runs(id) on delete cascade,
  apify_run_id text,
  apify_dataset_id text,
  source text not null default 'apify',
  payload jsonb not null,
  payload_hash text not null,
  collected_at timestamptz,
  niche text,
  city text
);

create unique index if not exists lead_feed_raw_items_payload_hash_idx
  on public.lead_feed_raw_items (payload_hash);

create table if not exists public.lead_feed_leads (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  run_id uuid references public.lead_feed_runs(id) on delete cascade,
  canonical_entity_id text not null,
  duplicate_group_id text not null,
  business_name text,
  niche text,
  city text,
  website text,
  phone text,
  email text,
  source text,
  source_url text,
  collected_at timestamptz,
  lead_score integer not null default 0,
  score_band text not null default 'low',
  recommended_action text not null default 'hold',
  score_breakdown jsonb not null default '{}'::jsonb,
  score_reasons jsonb not null default '[]'::jsonb,
  source_confidence numeric,
  extraction_confidence numeric
);

create unique index if not exists lead_feed_leads_run_entity_idx
  on public.lead_feed_leads (run_id, canonical_entity_id);

create index if not exists lead_feed_leads_run_id_idx on public.lead_feed_leads (run_id);
create index if not exists lead_feed_leads_duplicate_group_idx on public.lead_feed_leads (duplicate_group_id);
create index if not exists lead_feed_leads_score_idx on public.lead_feed_leads (lead_score desc);

create table if not exists public.lead_feed_alerts (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  lead_id bigint references public.lead_feed_leads(id) on delete cascade,
  run_id uuid references public.lead_feed_runs(id) on delete cascade,
  alert_type text not null,
  payload jsonb not null default '{}'::jsonb,
  delivered_at timestamptz
);

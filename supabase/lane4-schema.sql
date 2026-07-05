-- Lane 4: Reddit / Forums (r/instructionaldesign, r/elearning)
-- Signal-intelligence schema for buyer-pain and hiring-intent signals from forums.
-- Mirrors Lane 2/3 structure with forum-specific fields.
-- Apply after the TantaPulse schema is already in place.

create extension if not exists pgcrypto;

-- Lane 4: Forum feed run tracker
create table if not exists public.lane4_feed_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'queued',
  -- 'queued' | 'processing' | 'processed' | 'capped' | 'failed'
  source text not null default 'reddit',
  subreddit text not null,         -- 'instructionaldesign' | 'elearning'
  apify_run_id text,
  apify_dataset_id text,
  total_count integer not null default 0,
  unique_count integer not null default 0,
  high_count integer not null default 0,
  usable_count integer not null default 0,
  duplicate_rate numeric,
  summary jsonb not null default '{}'::jsonb,
  spend_check jsonb                -- budget check result at trigger time
);

create index if not exists lane4_feed_runs_status_idx on public.lane4_feed_runs (status);
create index if not exists lane4_feed_runs_subreddit_idx on public.lane4_feed_runs (subreddit);
create index if not exists lane4_feed_runs_requested_idx on public.lane4_feed_runs (requested_at desc);

-- Lane 4: raw scraped items before scoring
create table if not exists public.lane4_raw_items (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  run_id uuid references public.lane4_feed_runs(id) on delete cascade,
  apify_run_id text,
  apify_dataset_id text,
  payload jsonb not null,
  payload_hash text not null,
  collected_at timestamptz
);

create unique index if not exists lane4_raw_items_payload_hash_idx
  on public.lane4_raw_items (payload_hash);

-- Lane 4: scored + deduped forum posts
create table if not exists public.lane4_posts (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  run_id uuid references public.lane4_feed_runs(id) on delete cascade,
  canonical_entity_id text not null,
  duplicate_group_id text not null,
  post_id text,                     -- Reddit post ID
  post_title text,
  post_author text,
  post_url text,
  post_date timestamptz,
  subreddit text,
  raw_snippet text,
  upvotes integer not null default 0,
  comment_count integer not null default 0,
  source text not null default 'reddit',
  collected_at timestamptz,
  signal_score integer not null default 0,
  score_band text not null default 'low',
  recommended_action text not null default 'hold',
  score_breakdown jsonb not null default '{}'::jsonb,
  score_reasons jsonb not null default '[]'::jsonb,
  signal_count integer not null default 0,
  matched_signals text[]            -- array of keyword signal names detected
);

create unique index if not exists lane4_posts_run_entity_idx
  on public.lane4_posts (run_id, canonical_entity_id);

create index if not exists lane4_posts_run_id_idx on public.lane4_posts (run_id);
create index if not exists lane4_posts_dup_group_idx on public.lane4_posts (duplicate_group_id);
create index if not exists lane4_posts_score_idx on public.lane4_posts (signal_score desc);
create index if not exists lane4_posts_subreddit_idx on public.lane4_posts (subreddit);
create index if not exists lane4_posts_author_idx on public.lane4_posts (post_author);
create index if not exists lane4_posts_date_idx on public.lane4_posts (post_date desc);

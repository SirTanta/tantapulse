-- Agentic fulfillment loop: working opt-outs, all three paid tiers, recurring paid delivery.

create table if not exists public.lead_feed_unsubscribes (
  email text primary key,
  unsubscribed_at timestamptz not null default now(),
  source text not null default 'web'
);
alter table public.lead_feed_unsubscribes enable row level security;

alter table public.paid_subscribers
  drop constraint if exists paid_subscribers_monetization_tier_check;
alter table public.paid_subscribers
  add constraint paid_subscribers_monetization_tier_check
  check (monetization_tier in ('starter', 'growth', 'pro', 'agency'));

alter table public.paid_subscribers
  add column if not exists niche text,
  add column if not exists city text,
  add column if not exists onboarded_at timestamptz,
  add column if not exists last_delivered_at timestamptz;
alter table public.paid_subscribers enable row level security;

alter table public.lead_feed_leads
  drop constraint if exists lead_feed_leads_monetization_tier_check;
alter table public.lead_feed_leads
  add constraint lead_feed_leads_monetization_tier_check
  check (monetization_tier in ('starter', 'growth', 'pro', 'agency', 'sample'));

create index if not exists lead_feed_runs_source_status_idx
  on public.lead_feed_runs (source, status);

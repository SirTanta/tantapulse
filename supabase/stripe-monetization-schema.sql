-- Tantapulse Stripe monetization schema
-- Apply in Supabase before enabling Stripe checkout webhooks.

-- ── lead_feed_leads extensions ────────────────────────────────────────────────
-- These columns let us tag existing scraped leads that also became paying customers.
-- Note: lead_feed_leads.email does NOT exist — leads are scraped from Google Places.
-- For paid subscriber records, use paid_subscribers (below).

alter table public.lead_feed_leads
  add column if not exists monetization_tier text
    check (monetization_tier in ('starter', 'growth', 'sample')),
  add column if not exists stripe_customer_id text,
  add column if not exists subscription_status text
    check (subscription_status in ('active', 'cancelled', 'past_due', 'trialing')),
  add column if not exists subscription_id text,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists lead_feed_leads_stripe_customer_idx
  on public.lead_feed_leads (stripe_customer_id)
  where stripe_customer_id is not null;

create index if not exists lead_feed_leads_monetization_idx
  on public.lead_feed_leads (monetization_tier)
  where monetization_tier is not null;

-- ── paid_subscribers ─────────────────────────────────────────────────────────
-- Canonical table for Stripe paying customers.
-- Upserted by the Stripe webhook on checkout.session.completed / subscription events.
-- Email is the primary lookup key since scraped leads (lead_feed_leads) have no email.

create table if not exists public.paid_subscribers (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  email           text not null,
  name            text,
  stripe_customer_id text unique,
  subscription_id text,
  monetization_tier text check (monetization_tier in ('starter', 'growth')),
  subscription_status text check (subscription_status in ('active', 'cancelled', 'past_due', 'trialing')),
  tier_changed_at timestamptz
);

create unique index if not exists paid_subscribers_email_idx
  on public.paid_subscribers (email);

create index if not exists paid_subscribers_stripe_customer_idx
  on public.paid_subscribers (stripe_customer_id)
  where stripe_customer_id is not null;
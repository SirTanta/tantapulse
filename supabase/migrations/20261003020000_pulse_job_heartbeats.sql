-- Pulse pipeline job heartbeats: one row per scheduled/cron job, updated on
-- every invocation (success or failure) so a health check can tell whether a
-- job is actually running on schedule, not just that the cron entry exists.
-- Built 2026-10-03 as part of the TantaPulse proactive-failure-detection pass
-- (discovery scraper 404'd 3 months unnoticed; hello@ autoresponder dead 24
-- days unnoticed; webhook secret mismatch; Oct 2 stuck-lead loop).
create table if not exists public.pulse_job_heartbeats (
  job_name    text primary key,
  last_run_at timestamptz not null default now(),
  last_ok     boolean not null default true,
  detail      jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

comment on table public.pulse_job_heartbeats is
  'One row per TantaPulse cron/job. Updated on every invocation. Read by the thos-auto pulse-health-check.py cron and the Atlas TantaPulse dashboard to answer "is this job actually running" without scraping logs.';

-- Service role only (same access pattern as every other Pulse table); no
-- anon/public access, no RLS policy needed beyond the default deny.
alter table public.pulse_job_heartbeats enable row level security;

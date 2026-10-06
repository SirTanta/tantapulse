-- TantaPulse data cleanup + real tracking infrastructure (MCA audit, 2026-10-03).
-- Part 1: classify test/spam pollution across sample_intake_requests, lead_feed_runs,
--         lead_feed_leads without deleting any historical row.
-- Part 2: pulse_email_events (Resend webhook sink), replied_at on pulse_outreach_sends,
--         and FK linkage for sent -> opened -> clicked -> sample requested -> paid tracing.

-- ============================================================
-- 1. sample_intake_requests: classify the 12 existing rows
-- ============================================================
alter table public.sample_intake_requests
  add column if not exists source_type text not null default 'real'
    check (source_type in ('real', 'internal_test', 'spam'));
comment on column public.sample_intake_requests.source_type is
  'real = genuine external prospect request; internal_test = THOS/Pulse QA probe or E2E verification; spam = inbound SEO-pitch spam that landed in the intake form/table. Filter on this, not status, to exclude noise from real metrics.';

create index if not exists sample_intake_requests_source_type_idx
  on public.sample_intake_requests (source_type);

-- 10 internal QA / E2E verification probes
update public.sample_intake_requests
set source_type = 'internal_test'
where id in (
  '28dd9121-ca56-4111-a4ed-1d18e8525dd9', -- THOS Controlled QA
  'b73ffc0f-3241-4c34-82c6-36357e00e19f', -- TantaPulse Internal QA
  'cd99ee17-8a2c-44af-9e77-79645bd3310c', -- Test User
  '510470b9-e83e-4d78-b6b9-85a9f5ddf8fe', -- Test
  '69107a01-8288-4d05-8ec8-23c64b47ca8d', -- source-readback-probe (MCA-58)
  '5effc415-1cb6-414d-9f10-d251de1d2ec3', -- dup probe
  '1b92cb4f-9f4a-429e-9369-7a8c68e72bd8', -- MCA-58 v2 probe
  'b1f6643f-573d-4730-b06b-58aa87a8ad65', -- MCA-58 v2 probe b
  'a7b4e508-a198-4248-9b2c-1ca8beb3e46a', -- Holo Probe (ran through real delivery path as a drill)
  'e21624c9-703f-4e9c-82a7-07600ec7201c'  -- Jon Edwards E2E verification of the agentic Pulse loop
);

-- 2 inbound spam (SEO-pitch bots submitting the sample-intake form), not real prospect requests
update public.sample_intake_requests
set source_type = 'spam'
where id in (
  'fcf97732-adc3-4237-84d1-60162f543e8d', -- Brianna Belton SEO pitch
  'b005fd6c-bd82-43d6-83a0-299792c61579'  -- Diana Cruz SEO pitch
);

-- ============================================================
-- 2. lead_feed_runs / lead_feed_leads: same treatment
-- ============================================================
alter table public.lead_feed_runs
  add column if not exists source_type text not null default 'real'
    check (source_type in ('real', 'internal_test', 'spam'));
comment on column public.lead_feed_runs.source_type is
  'real = production scrape/delivery run; internal_test = QA/verification/capacity-check run; spam = inbound spam mistakenly ingested as a run. lead_feed_leads.source_type is backfilled from the parent run.';

alter table public.lead_feed_leads
  add column if not exists source_type text not null default 'real'
    check (source_type in ('real', 'internal_test', 'spam'));
comment on column public.lead_feed_leads.source_type is
  'Inherited from lead_feed_runs.source_type at classification time (2026-10-03 audit). New rows default to real; keep in sync with the parent run going forward.';

create index if not exists lead_feed_runs_source_type_idx on public.lead_feed_runs (source_type);
create index if not exists lead_feed_leads_source_type_idx on public.lead_feed_leads (source_type);

update public.lead_feed_runs set source_type = 'internal_test' where id in (
  '94ad11ef-f7c9-4431-86cb-d4b83efc4c51', -- jedwards+verify2 go-live verification
  '3414e206-9395-4442-bf5f-6e3c56fca115', -- jedwards+verify3 automation verification
  '4ac47686-fb57-4359-8c45-171dee3f0ac4', -- jedwards+verify4 budget-cap verification
  '2f12c13f-f52c-473e-95e8-1c1caf041f39', -- test@test.com / niche=test api check
  '72a14473-b437-4914-8387-b745724b1f82', -- qa-test@tantaholdings.com
  '8dc73063-9b40-4645-bd03-cad81e827531', -- hello@tantapulse.com internal P0 capacity verification
  '0d79897b-00ad-44d9-b635-8c9e54082580', -- Holo Probe delivery drill
  '391bc6f4-c6a5-40f6-be34-04a785e7fe5c'  -- Jon Edwards E2E verification
);

update public.lead_feed_runs set source_type = 'spam' where id in (
  '592669d4-12b1-4658-8504-d097c8e4fcda'  -- Pranab inbound SEO-pitch spam captured as a run
);

update public.lead_feed_leads l
set source_type = r.source_type
from public.lead_feed_runs r
where l.run_id = r.id and r.source_type <> 'real';

-- ============================================================
-- 3. pulse_outreach_sends: reply detection + verified FK to leads
-- ============================================================
alter table public.pulse_outreach_sends
  add column if not exists replied_at timestamptz;
comment on column public.pulse_outreach_sends.replied_at is
  'Set by api/pulse/check-replies.js polling hello@tantapulse.com via the Zoho Mail API (TANTAPULSE_ZOHO_OAUTH_REFRESH_TOKEN_READONLY) and matching inbound sender addresses against this row''s email. Populated live as of 2026-10-03; null = no reply detected yet.';

create index if not exists pulse_outreach_sends_replied_at_idx
  on public.pulse_outreach_sends (replied_at);

-- lead_id has always pointed at leads.id by convention (fulfill.js) but had no enforced FK.
-- Add it for real referential integrity now that we're building conversion tracing on top of it.
alter table public.pulse_outreach_sends
  add constraint pulse_outreach_sends_lead_id_fkey
  foreign key (lead_id) references public.leads(id) on delete set null
  not valid;
alter table public.pulse_outreach_sends
  validate constraint pulse_outreach_sends_lead_id_fkey;

-- ============================================================
-- 4. Conversion tracing: sample_intake_requests / paid_subscribers -> leads
-- ============================================================
alter table public.sample_intake_requests
  add column if not exists lead_id uuid references public.leads(id) on delete set null;
comment on column public.sample_intake_requests.lead_id is
  'Backfilled/linked when request_email''s domain matches an outreach lead''s domain, so a sample request can be traced back to the cold-outreach send that produced it. Null = organic/no match found.';
create index if not exists sample_intake_requests_lead_id_idx on public.sample_intake_requests (lead_id);

alter table public.paid_subscribers
  add column if not exists lead_id uuid references public.leads(id) on delete set null;
comment on column public.paid_subscribers.lead_id is
  'Linked at Stripe-webhook onboarding time when the subscriber email''s domain matches an outreach lead''s domain, so a paid conversion can be traced end-to-end: sent -> opened -> clicked -> sample requested -> paid.';
create index if not exists paid_subscribers_lead_id_idx on public.paid_subscribers (lead_id);

-- ============================================================
-- 5. pulse_email_events: Resend webhook sink
-- ============================================================
create table if not exists public.pulse_email_events (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  resend_id text not null,
  event_type text not null check (event_type in (
    'email.sent', 'email.delivered', 'email.delivery_delayed',
    'email.opened', 'email.clicked', 'email.bounced', 'email.complained'
  )),
  occurred_at timestamptz not null,
  recipient text,
  link_url text,
  payload jsonb not null default '{}'::jsonb
);

-- Resend can and does redeliver webhook events; de-dupe on (resend_id, event_type, occurred_at).
create unique index if not exists pulse_email_events_dedupe_idx
  on public.pulse_email_events (resend_id, event_type, occurred_at);
create index if not exists pulse_email_events_resend_id_idx on public.pulse_email_events (resend_id);
create index if not exists pulse_email_events_event_type_idx on public.pulse_email_events (event_type);
create index if not exists pulse_email_events_occurred_at_idx on public.pulse_email_events (occurred_at);

alter table public.pulse_email_events enable row level security;

comment on table public.pulse_email_events is
  'Delivery-event sink for every Resend-sent TantaPulse email (market check, paid feed, onboarding, cold outreach). Populated by the api/pulse/webhook.js Resend webhook handler. Join to pulse_outreach_sends.resend_id / lead_feed_runs via the id Resend returned at send time.';

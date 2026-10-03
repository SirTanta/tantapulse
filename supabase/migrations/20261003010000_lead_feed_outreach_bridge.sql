-- Bridges lead_feed_leads (Apify Google-Places discovery, scored, no verified email)
-- into the existing Hunter-enriched outreach pool (leads/contacts), so the one real
-- outreach-sending path (api/sample-intake/fulfill.js outreach()) can reach them too,
-- using the exact same vetting bar it already applies (hunter_confidence>=80,
-- hunter_verifier_status='valid') and the exact same daily/pass send caps.
-- Connects the pipe; does not change send volume or vetting criteria.

alter table public.lead_feed_leads
  add column if not exists bridged_lead_id uuid references public.leads(id) on delete set null;
comment on column public.lead_feed_leads.bridged_lead_id is
  'Set by api/lead-feed/bridge.js once a Hunter.io domain-search email clears the same hunter_confidence>=80 + valid-verifier bar used for every other outreach lead. Points at the leads row that api/sample-intake/fulfill.js''s existing outreach() picks up for sending -- no separate send path.';

alter table public.lead_feed_leads
  add column if not exists bridge_status text
    check (bridge_status in ('bridged', 'no_email', 'low_confidence', 'error') or bridge_status is null);
comment on column public.lead_feed_leads.bridge_status is
  'Outcome of the last bridge attempt: bridged = email found + verified, cleared into leads/contacts; no_email = Hunter domain-search returned nothing usable; low_confidence = an email was found but did not clear the bar; error = the Hunter call itself failed (retry later). Null = never attempted.';

alter table public.lead_feed_leads
  add column if not exists bridge_checked_at timestamptz;
comment on column public.lead_feed_leads.bridge_checked_at is
  'When the bridge last attempted this row, so the cron does not re-spend a Hunter credit on the same business every run.';

create index if not exists lead_feed_leads_bridge_pending_idx
  on public.lead_feed_leads (score_band, source_type)
  where bridge_checked_at is null;

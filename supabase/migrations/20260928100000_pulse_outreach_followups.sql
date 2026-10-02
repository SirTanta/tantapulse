alter table public.pulse_outreach_sends
  add column if not exists sequence integer not null default 1;

alter table public.pulse_outreach_sends
  drop constraint if exists pulse_outreach_sends_lead_id_key;

create unique index if not exists pulse_outreach_sends_lead_sequence_idx
  on public.pulse_outreach_sends (lead_id, sequence);

create index if not exists pulse_outreach_sends_sequence_sent_at_idx
  on public.pulse_outreach_sends (sequence, sent_at);

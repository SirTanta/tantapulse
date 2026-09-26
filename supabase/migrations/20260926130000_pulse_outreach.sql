create table if not exists public.pulse_outreach_sends (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null unique,
  email text not null,
  resend_id text,
  sent_at timestamptz not null default now()
);
create index if not exists pulse_outreach_sends_sent_at_idx on public.pulse_outreach_sends (sent_at);
alter table public.pulse_outreach_sends enable row level security;

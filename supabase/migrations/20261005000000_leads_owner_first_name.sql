-- Owner first-name capture for cold outreach (lib/owner-name.mjs). Greeting uses the name only
-- when owner_name_confidence = 'high'; any null/other value keeps the company greeting.
alter table public.leads add column if not exists owner_first_name text;
alter table public.leads add column if not exists owner_name_source text
  check (owner_name_source in ('hunter', 'website') or owner_name_source is null);
alter table public.leads add column if not exists owner_name_confidence text
  check (owner_name_confidence in ('high') or owner_name_confidence is null);
comment on column public.leads.owner_first_name is
  'Business owner/founder first name captured from Hunter person data or an explicitly labelled About/Team page. Only used in outreach when owner_name_confidence = ''high''.';
comment on column public.leads.owner_name_source is
  'Where owner_first_name came from: hunter (Domain Search position + email local part) or website (page text explicitly labels the person owner/founder/CEO/president).';
comment on column public.leads.owner_name_confidence is
  'high is the only value that is ever written or honoured; null means use the company greeting.';

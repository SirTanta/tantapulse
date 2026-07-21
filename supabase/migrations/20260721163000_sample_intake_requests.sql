-- Fail-closed TantaPulse sample intake CRM boundary.
-- Apply this file through the approved production Supabase SQL Editor before deploying.

create extension if not exists pgcrypto;

create table if not exists public.sample_intake_requests (
  id uuid primary key default gen_random_uuid(),
  receipt_id text not null unique default encode(gen_random_bytes(18), 'hex'),
  dedupe_key text not null unique,
  owner_profile text not null default 'sakuya',
  queue text not null default 'sample_intake',
  status text not null default 'queued',
  sla_due_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  requested_at timestamptz not null default now(),
  duplicate_count integer not null default 0,
  last_duplicate_at timestamptz,
  request_name text not null,
  request_email text not null,
  niche text not null,
  city text not null,
  cadence text not null,
  notes text not null default ''
);

create index if not exists sample_intake_requests_owner_status_sla_idx
  on public.sample_intake_requests (owner_profile, status, sla_due_at);

create or replace function public.intake_sample_request(
  p_name text,
  p_email text,
  p_niche text,
  p_city text,
  p_cadence text,
  p_notes text,
  p_dedupe_key text
)
returns table (
  receipt_id text,
  status text,
  owner text,
  sla_due_at timestamptz,
  duplicate boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  intake public.sample_intake_requests%rowtype;
begin
  insert into public.sample_intake_requests (
    dedupe_key, owner_profile, queue, status, sla_due_at,
    request_name, request_email, niche, city, cadence, notes
  ) values (
    p_dedupe_key, 'sakuya', 'sample_intake', 'queued', now() + interval '1 day',
    p_name, p_email, p_niche, p_city, p_cadence, p_notes
  )
  on conflict (dedupe_key) do nothing
  returning * into intake;

  if found then
    return query select intake.receipt_id, intake.status, intake.owner_profile, intake.sla_due_at, false;
    return;
  end if;

  update public.sample_intake_requests as existing
  set duplicate_count = existing.duplicate_count + 1,
      last_duplicate_at = now(),
      updated_at = now()
  where existing.dedupe_key = p_dedupe_key
  returning * into intake;

  if not found then
    raise exception 'sample intake persistence was not confirmed';
  end if;

  return query select intake.receipt_id, intake.status, intake.owner_profile, intake.sla_due_at, true;
end;
$$;

revoke all on function public.intake_sample_request(text, text, text, text, text, text, text) from public;
grant execute on function public.intake_sample_request(text, text, text, text, text, text, text) to service_role;

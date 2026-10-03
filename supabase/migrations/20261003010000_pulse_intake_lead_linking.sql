-- Conversion tracing (Part 2.3 of the 2026-10-03 TantaPulse tracking build):
-- when a sample-intake request's email domain matches a cold-outreach lead's
-- domain, link sample_intake_requests.lead_id automatically at insert time so
-- the funnel (sent -> opened -> clicked -> sample requested -> paid) can be
-- traced without a separate backfill job. No-op (lead_id stays null) when no
-- match exists -- organic/non-outreach-driven requests are expected and fine.

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
  v_domain text;
  v_lead_id uuid;
begin
  v_domain := lower(split_part(p_email, '@', 2));
  if v_domain <> '' then
    select l.id into v_lead_id
    from public.leads l
    where lower(l.domain) = v_domain
    order by l.created_at desc
    limit 1;
  end if;

  insert into public.sample_intake_requests (
    dedupe_key, owner_profile, queue, status, sla_due_at,
    request_name, request_email, niche, city, cadence, notes, lead_id
  ) values (
    p_dedupe_key, 'sakuya', 'sample_intake', 'queued', now() + interval '1 day',
    p_name, p_email, p_niche, p_city, p_cadence, p_notes, v_lead_id
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
      updated_at = now(),
      lead_id = coalesce(existing.lead_id, v_lead_id)
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

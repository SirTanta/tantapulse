-- Persist optional UTM and browser attribution data for sample intake requests.
-- The existing seven-argument RPC is retained so submissions from a prior frontend
-- continue to work and leave these new nullable fields as NULL.

alter table public.sample_intake_requests
  add column if not exists utm_source text,
  add column if not exists utm_medium text,
  add column if not exists utm_campaign text,
  add column if not exists utm_content text,
  add column if not exists utm_term text,
  add column if not exists landing_page text,
  add column if not exists referrer text;

create or replace function public.intake_sample_request(
  p_name text,
  p_email text,
  p_niche text,
  p_city text,
  p_cadence text,
  p_notes text,
  p_utm_source text,
  p_utm_medium text,
  p_utm_campaign text,
  p_utm_content text,
  p_utm_term text,
  p_landing_page text,
  p_referrer text,
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
    request_name, request_email, niche, city, cadence, notes,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    landing_page, referrer
  ) values (
    p_dedupe_key, 'sakuya', 'sample_intake', 'queued', now() + interval '1 day',
    p_name, p_email, p_niche, p_city, p_cadence, p_notes,
    p_utm_source, p_utm_medium, p_utm_campaign, p_utm_content, p_utm_term,
    p_landing_page, p_referrer
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

revoke all on function public.intake_sample_request(
  text, text, text, text, text, text, text, text, text, text, text, text, text, text
) from public;
grant execute on function public.intake_sample_request(
  text, text, text, text, text, text, text, text, text, text, text, text, text, text
) to service_role;

-- Manual rollback (apply only after reverting the API/frontend that calls the
-- fourteen-argument RPC; the pre-existing seven-argument RPC remains intact):
-- drop function if exists public.intake_sample_request(
--   text, text, text, text, text, text, text, text, text, text, text, text, text, text
-- );
-- alter table public.sample_intake_requests
--   drop column if exists referrer,
--   drop column if exists landing_page,
--   drop column if exists utm_term,
--   drop column if exists utm_content,
--   drop column if exists utm_campaign,
--   drop column if exists utm_medium,
--   drop column if exists utm_source;

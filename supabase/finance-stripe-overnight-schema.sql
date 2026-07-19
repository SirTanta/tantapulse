-- Stripe overnight read-only finance ingestion surfaces.
-- Apply this migration before enabling the Vercel cron registration.

create table if not exists public.finance_event_dedupe (
  dedupe_key text primary key,
  account_id text not null,
  event_type text not null,
  event_date date not null,
  entity_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists finance_event_dedupe_account_date_idx
  on public.finance_event_dedupe (account_id, event_date desc);

create table if not exists public.finance_signals (
  id bigserial primary key,
  signal_key text not null unique,
  entity_id text not null,
  signal_type text not null,
  event_type text not null,
  event_date date not null,
  dedupe_key text not null unique references public.finance_event_dedupe(dedupe_key),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_signals_event_date_idx
  on public.finance_signals (event_date desc, signal_type);

create table if not exists public.quiet_receipt_log (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  run_timestamp_utc timestamptz not null,
  window_open boolean not null,
  candidate_count integer not null default 0 check (candidate_count >= 0),
  dedupe_count integer not null default 0 check (dedupe_count >= 0),
  pagination_exhausted boolean not null default false,
  mode text not null check (mode in ('outside_window_noop', 'read_only_ingestion', 'error')),
  sources jsonb not null default '{}'::jsonb
);

create index if not exists quiet_receipt_log_run_timestamp_idx
  on public.quiet_receipt_log (run_timestamp_utc desc);

-- The scheduler uses the Supabase service role. No browser or authenticated-user
-- access is permitted to finance intake, signals, or receipts.
alter table public.finance_event_dedupe enable row level security;
alter table public.finance_signals enable row level security;
alter table public.quiet_receipt_log enable row level security;

-- One transaction makes dedupe claiming and canonical signal persistence indivisible.
create or replace function public.persist_finance_signals_atomically(signal_rows jsonb)
returns table(inserted_count integer, dedupe_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  total_count integer;
  saved_count integer;
begin
  with input_rows as (
    select * from jsonb_to_recordset(signal_rows) as row(
      dedupe_key text, account_id text, entity_id text, signal_key text,
      signal_type text, event_type text, event_date date
    )
  ), inserted_dedupe as (
    insert into public.finance_event_dedupe (dedupe_key, account_id, event_type, event_date, entity_id)
    select dedupe_key, account_id, event_type, event_date, entity_id from input_rows
    on conflict (dedupe_key) do nothing
    returning dedupe_key
  ), inserted_signals as (
    insert into public.finance_signals (signal_key, entity_id, signal_type, event_type, event_date, dedupe_key)
    select input_rows.signal_key, input_rows.entity_id, input_rows.signal_type,
           input_rows.event_type, input_rows.event_date, input_rows.dedupe_key
    from input_rows join inserted_dedupe using (dedupe_key)
    returning signal_key
  )
  select (select count(*) from input_rows), (select count(*) from inserted_signals)
  into total_count, saved_count;

  return query select saved_count, total_count - saved_count;
end;
$$;

revoke all on function public.persist_finance_signals_atomically(jsonb) from public;
grant execute on function public.persist_finance_signals_atomically(jsonb) to service_role;

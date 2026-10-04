-- Piece 3: sign-up onboarding.
-- Run once in the Supabase SQL editor. Safe to run again. The site keeps working before and after.
--
--  1. join_requests: "this person asked to join that venue and is waiting". Piece 3 only READS it
--     (to show the Pending screen); piece 4 (join codes + approval screen) is what writes to it.
--  2. One venue per owner email: a second venue for the same owner is refused by the database,
--     not just by the code.
--
-- To undo: db/venues-onboarding-rollback.sql

-- venue_id has to be the same type as venues.id, whatever that is in your database.
do $$
declare t text;
begin
  select format_type(a.atttypid, a.atttypmod) into t
  from pg_attribute a
  where a.attrelid = 'public.venues'::regclass and a.attname = 'id' and not a.attisdropped;
  if t is null then raise exception 'public.venues.id not found: run db/venues-groundwork.sql first'; end if;

  execute format($f$
    create table if not exists public.join_requests (
      id           bigserial primary key,
      venue_id     %s not null references public.venues(id) on delete cascade,
      email        text not null,
      name         text,
      status       text not null default 'pending' check (status in ('pending','approved','declined','cancelled')),
      requested_at timestamptz not null default now(),
      decided_at   timestamptz
    )$f$, t);
end $$;

-- A person can wait on only one venue at a time.
create unique index if not exists join_requests_one_pending_per_email
  on public.join_requests (lower(email)) where status = 'pending';

-- Same protection as the other tables: only the Netlify Functions (service-role key) can touch it.
alter table public.join_requests enable row level security;

-- One live venue per owner email.
create unique index if not exists venues_one_per_owner
  on public.venues (lower(owner_email)) where deleted_at is null;

-- Check: both lines should say "ok".
select 'join_requests table' as what, case when to_regclass('public.join_requests') is not null then 'ok' else 'MISSING' end as result
union all
select 'one venue per owner', case when exists (select 1 from pg_indexes where indexname = 'venues_one_per_owner') then 'ok' else 'MISSING' end;

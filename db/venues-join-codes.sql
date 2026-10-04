-- Piece 4: join codes + the approval screen.
-- Run once in the Supabase SQL editor, AFTER db/venues-onboarding.sql. Safe to run again.
-- The site keeps working before and after (the new page and the "Have a join code?" form
-- only start working once this has been run).
--
--  1. join_codes: a code an admin hands out. Each code carries the role and page access that
--     whoever uses it will get, an expiry date, and an optional limit on how many people may use it.
--  2. join_requests gets the columns it needs to remember that preset (copied from the code at the
--     moment someone asks to join, so turning a code off later can't change what was promised).
--
-- Codes are unique across ALL venues, because a person types a code without saying which venue it is for.
--
-- To undo: db/venues-join-codes-rollback.sql

do $$
declare t text;
begin
  select format_type(a.atttypid, a.atttypmod) into t
  from pg_attribute a
  where a.attrelid = 'public.venues'::regclass and a.attname = 'id' and not a.attisdropped;
  if t is null then raise exception 'public.venues.id not found: run db/venues-groundwork.sql first'; end if;
  if to_regclass('public.join_requests') is null then raise exception 'public.join_requests not found: run db/venues-onboarding.sql first'; end if;

  execute format($f$
    create table if not exists public.join_codes (
      id             bigserial primary key,
      venue_id       %s not null references public.venues(id) on delete cascade,
      code           text not null check (code ~ '^[A-Z0-9]{8}$'),
      role_id        text,
      perm_inventory text not null default 'none' check (perm_inventory in ('none','view','edit')),
      perm_call_list text not null default 'none' check (perm_call_list in ('none','view','edit')),
      perm_employees text not null default 'none' check (perm_employees in ('none','view','edit')),
      perm_settings  text not null default 'none' check (perm_settings  in ('none','view','edit')),
      max_uses       integer check (max_uses is null or max_uses > 0),
      expires_at     timestamptz not null,
      created_by     text,
      created_at     timestamptz not null default now(),
      revoked_at     timestamptz
    )$f$, t);
end $$;

create unique index if not exists join_codes_code_key on public.join_codes (code);
create index if not exists join_codes_venue_idx on public.join_codes (venue_id);

-- If the role a code points at is deleted, the code stays but hands out no role.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'join_codes_venue_role_fkey') then
    alter table public.join_codes
      add constraint join_codes_venue_role_fkey
      foreign key (venue_id, role_id) references public.roles (venue_id, id) on delete set null (role_id);
  end if;
end $$;

alter table public.join_codes enable row level security;   -- no policies: only the Netlify Functions can touch it

-- What a pending request will become once approved.
alter table public.join_requests add column if not exists code_id bigint references public.join_codes(id) on delete set null;
alter table public.join_requests add column if not exists role_id text;
alter table public.join_requests add column if not exists perm_inventory text not null default 'none';
alter table public.join_requests add column if not exists perm_call_list text not null default 'none';
alter table public.join_requests add column if not exists perm_employees text not null default 'none';
alter table public.join_requests add column if not exists perm_settings  text not null default 'none';
alter table public.join_requests add column if not exists decided_by text;

create index if not exists join_requests_venue_status_idx on public.join_requests (venue_id, status);
create index if not exists join_requests_code_idx on public.join_requests (code_id);

-- Check: every line should say "ok".
select 'join_codes table' as what, case when to_regclass('public.join_codes') is not null then 'ok' else 'MISSING' end as result
union all
select 'codes are unique', case when exists (select 1 from pg_indexes where indexname = 'join_codes_code_key') then 'ok' else 'MISSING' end
union all
select 'join_requests.code_id', case when exists (select 1 from information_schema.columns where table_name = 'join_requests' and column_name = 'code_id') then 'ok' else 'MISSING' end
union all
select 'join_requests.perm_settings', case when exists (select 1 from information_schema.columns where table_name = 'join_requests' and column_name = 'perm_settings') then 'ok' else 'MISSING' end;

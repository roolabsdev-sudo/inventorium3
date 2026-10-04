-- Scanner codes: turn a spare phone/tablet into a scan-only device.
-- Run once in the Supabase SQL editor, AFTER db/venues-onboarding.sql. Safe to run again.
-- The site keeps working before and after (the Scanners page and the scanner-code box on the
-- sign-in page only start working once this has been run).
--
--  1. scanner_codes:   a one-time code an admin hands out. Valid for a short time, for 1-10 devices.
--  2. scanner_devices: one row per device that has entered a code. The device holds a random token;
--                      only a hash of it is stored here. A device works until it signs out or an
--                      admin removes it.
--
-- Codes are unique across ALL venues, because a person types a code without saying which venue it is for.
--
-- To undo: db/venues-scanner-codes-rollback.sql

do $$
declare t text;
begin
  select format_type(a.atttypid, a.atttypmod) into t
  from pg_attribute a
  where a.attrelid = 'public.venues'::regclass and a.attname = 'id' and not a.attisdropped;
  if t is null then raise exception 'public.venues.id not found: run db/venues-groundwork.sql first'; end if;

  execute format($f$
    create table if not exists public.scanner_codes (
      id          bigserial primary key,
      venue_id    %s not null references public.venues(id) on delete cascade,
      code        text not null check (code ~ '^[A-Z0-9]{8}$'),
      label       text,
      max_devices integer not null default 1 check (max_devices between 1 and 10),
      expires_at  timestamptz not null,
      created_by  text,
      created_at  timestamptz not null default now(),
      revoked_at  timestamptz
    )$f$, t);

  execute format($f$
    create table if not exists public.scanner_devices (
      id           bigserial primary key,
      venue_id     %s not null references public.venues(id) on delete cascade,
      code_id      bigint references public.scanner_codes(id) on delete set null,
      token_hash   text not null,
      label        text,
      created_at   timestamptz not null default now(),
      last_seen_at timestamptz,
      revoked_at   timestamptz
    )$f$, t);
end $$;

create unique index if not exists scanner_codes_code_key on public.scanner_codes (code);
create index if not exists scanner_codes_venue_idx on public.scanner_codes (venue_id);
create unique index if not exists scanner_devices_token_key on public.scanner_devices (token_hash);
create index if not exists scanner_devices_venue_idx on public.scanner_devices (venue_id);
create index if not exists scanner_devices_code_idx on public.scanner_devices (code_id);

alter table public.scanner_codes enable row level security;    -- no policies: only the Netlify Functions can touch these
alter table public.scanner_devices enable row level security;

-- Check: every line should say "ok".
select 'scanner_codes table' as what, case when to_regclass('public.scanner_codes') is not null then 'ok' else 'MISSING' end as result
union all
select 'scanner_devices table', case when to_regclass('public.scanner_devices') is not null then 'ok' else 'MISSING' end
union all
select 'codes are unique', case when exists (select 1 from pg_indexes where indexname = 'scanner_codes_code_key') then 'ok' else 'MISSING' end
union all
select 'device tokens are unique', case when exists (select 1 from pg_indexes where indexname = 'scanner_devices_token_key') then 'ok' else 'MISSING' end;

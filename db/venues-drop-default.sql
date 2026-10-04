-- Run this LAST, after the piece-2 code is deployed and working.
-- Removes the "new rows go to Venue #1" default so a function that forgets to
-- set venue_id fails loudly instead of silently filing data under Venue #1.
-- (venue_id is NOT NULL, so such an insert is rejected.)

do $$
declare t text;
begin
  foreach t in array array['employees', 'roles', 'locations', 'items', 'shows', 'show_roles', 'call_list', 'activity_log'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I alter column venue_id drop default', t);
    end if;
  end loop;
end $$;

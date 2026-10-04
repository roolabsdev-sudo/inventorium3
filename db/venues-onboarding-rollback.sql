-- Undo db/venues-onboarding.sql. Deletes any join requests (none exist until piece 4 ships).
drop index if exists public.venues_one_per_owner;
drop table if exists public.join_requests;

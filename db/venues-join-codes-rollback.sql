-- Undo db/venues-join-codes.sql. Deletes all join codes. Pending requests stay (they just lose their preset).
alter table public.join_requests drop column if exists code_id;
alter table public.join_requests drop column if exists role_id;
alter table public.join_requests drop column if exists perm_inventory;
alter table public.join_requests drop column if exists perm_call_list;
alter table public.join_requests drop column if exists perm_employees;
alter table public.join_requests drop column if exists perm_settings;
alter table public.join_requests drop column if exists decided_by;
drop table if exists public.join_codes;

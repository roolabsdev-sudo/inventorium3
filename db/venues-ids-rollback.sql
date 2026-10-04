-- Undo db/venues-ids.sql: primary keys go back to plain `id`.
-- This FAILS (and changes nothing) if two venues already share an id, which is
-- the safe outcome. Only run it before a second venue has data, and redeploy the
-- pre-piece-2 code afterwards.

begin;

do $$
declare r record; t text;
begin
  for r in
    select conrelid::regclass::text as tbl, conname from pg_constraint
     where contype = 'f'
       and conrelid  in ('public.items'::regclass, 'public.call_list'::regclass)
       and confrelid in ('public.employees'::regclass, 'public.shows'::regclass, 'public.show_roles'::regclass)
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;

  alter table public.call_list drop constraint if exists call_list_venue_show_emp_key;

  foreach t in array array['employees', 'roles', 'locations', 'items', 'shows', 'show_roles', 'call_list', 'activity_log'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_pkey');
    execute format('alter table public.%I add primary key (id)', t);
  end loop;

  alter table public.call_list add constraint call_list_show_id_emp_id_key unique (show_id, emp_id);
  alter table public.items add constraint items_holder_fkey
    foreign key (holder) references public.employees (id) on delete set null;
  alter table public.call_list add constraint call_list_show_id_fkey
    foreign key (show_id) references public.shows (id) on delete cascade;
  alter table public.call_list add constraint call_list_emp_id_fkey
    foreign key (emp_id) references public.employees (id) on delete cascade;
  alter table public.call_list add constraint call_list_show_role_id_fkey
    foreign key (show_role_id) references public.show_roles (id) on delete set null;
end $$;

commit;

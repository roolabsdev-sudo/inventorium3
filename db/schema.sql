-- Inventorium — Supabase schema
--
-- Run this once in the Supabase SQL editor (Project > SQL Editor > New query)
-- after creating your Supabase project. See /db/README.md for the full setup
-- walkthrough, including how this connects to Netlify Identity for login.
--
-- Design notes:
--  - IDs are text, not serial integers, so existing localStorage IDs
--    (e.g. "LX-0001", "ID-1000") can be migrated in unchanged.
--  - Row Level Security (RLS) is enabled on every table. The Netlify
--    Functions use the service-role key, which bypasses RLS, so all
--    permission checks happen in the function code — RLS here is a
--    second line of defense in case a key is ever used client-side
--    by mistake, not the primary access control.
--  - "employees.email" is the login username for Netlify Identity. It
--    must be unique and should match the email the person logs in with.

-- ---------- Employees ----------
create table if not exists employees (
  id text primary key,
  name text not null,
  role_id text,
  active boolean not null default true,
  photo text,                      -- data URI or storage URL
  email text unique,               -- login username (Netlify Identity email)
  perm_inventory text not null default 'none',   -- 'none' | 'view' | 'edit'
  perm_call_list text not null default 'none',
  perm_employees text not null default 'none',
  perm_settings text not null default 'none',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Role categories (person roles, e.g. Student Crew) ----------
create table if not exists roles (
  id text primary key,
  name text not null unique
);

-- ---------- Storage locations ----------
create table if not exists locations (
  id text primary key,
  name text not null unique
);

-- ---------- Items ----------
create table if not exists items (
  id text primary key,
  group_id text,                         -- shared by multiple units of the same item (e.g. LX-0002-1, LX-0002-2)
  name text not null,
  category text,
  location text,                         -- location NAME (renames cascade from Settings)
  status text not null default 'ok',     -- 'ok' | 'out' | 'maint' | 'fault'
  aliases text,
  notes text,
  holder text references employees(id) on delete set null,
  due timestamptz,
  restricted_to jsonb not null default '[]'::jsonb,  -- array of role ids
  photo text,
  serial text,
  condition text,
  purchase_date date,
  purchase_cost numeric,
  manual_url text,
  tracking_mode text,                    -- null/'unit' for serialized gear, 'consumable' for stock-counted items
  quantity numeric,
  unit_label text,
  min_quantity numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Show roles (call-list positions, e.g. Stage Manager) ----------
create table if not exists show_roles (
  id text primary key,
  name text not null unique
);

-- ---------- Shows ----------
create table if not exists shows (
  id text primary key,
  name text not null
);

-- ---------- Call list entries ----------
create table if not exists call_list (
  id text primary key,
  show_id text not null references shows(id) on delete cascade,
  emp_id text not null references employees(id) on delete cascade,
  show_role_id text references show_roles(id) on delete set null,
  comm boolean not null default false,
  unique (show_id, emp_id)
);

-- ---------- Activity log ----------
create table if not exists activity_log (
  id text primary key,
  ts timestamptz not null default now(),
  type text not null,
  item_id text,
  item_name text,
  emp_id text,
  emp_name text,
  note text
);

-- ---------- Row Level Security ----------
-- Enabled as defense-in-depth. The service-role key used by Netlify
-- Functions bypasses these policies entirely; these only matter if a
-- client ever connects directly with the anon key (which this app
-- does not do by design — all access goes through the Functions).
alter table employees enable row level security;
alter table roles enable row level security;
alter table locations enable row level security;
alter table items enable row level security;
alter table show_roles enable row level security;
alter table shows enable row level security;
alter table call_list enable row level security;
alter table activity_log enable row level security;

-- No policies are created, which means: with RLS enabled and no
-- policies, the anon/authenticated keys can read or write NOTHING.
-- Only the service-role key (used server-side only) can access data.

-- ---------- Helpful indexes ----------
create index if not exists idx_items_status on items(status);
create index if not exists idx_items_holder on items(holder);
create index if not exists idx_items_group on items(group_id);
create index if not exists idx_call_list_show on call_list(show_id);
create index if not exists idx_call_list_emp on call_list(emp_id);
create index if not exists idx_activity_log_ts on activity_log(ts desc);
create index if not exists idx_employees_email on employees(email);

-- ---------- Branding (venue name / subtitle / logo shown in the app) ----------
create table if not exists app_branding (
  id text primary key default 'default' check (id = 'default'),
  app_name text not null default 'Inventorium',
  app_subtitle text not null default '',
  logo text,                              -- small PNG/JPEG/WebP data URI
  updated_at timestamptz not null default now()
);
alter table app_branding enable row level security;   -- no policies: only the server key can touch it

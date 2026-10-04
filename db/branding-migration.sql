-- Run once in the Supabase SQL editor (existing databases).
-- Stores the venue name, subtitle and logo shown in the app. One row only.
create table if not exists app_branding (
  id text primary key default 'default' check (id = 'default'),
  app_name text not null default 'Inventorium',
  app_subtitle text not null default '',
  logo text,                              -- small PNG/JPEG/WebP data URI
  updated_at timestamptz not null default now()
);
alter table app_branding enable row level security;   -- no policies: only the server key can touch it

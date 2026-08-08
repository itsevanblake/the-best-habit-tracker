-- Habit Tracker sync schema.
-- Paste this whole file into Supabase's SQL Editor (Dashboard -> SQL Editor
-- -> New query) and run it once, after creating your project.

create table if not exists public.habit_tracker_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{"habits": [], "entries": {}}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.habit_tracker_data enable row level security;

-- Each signed-in user can only ever read or write their own row.
create policy "select own habit data"
  on public.habit_tracker_data for select
  using (auth.uid() = user_id);

create policy "insert own habit data"
  on public.habit_tracker_data for insert
  with check (auth.uid() = user_id);

create policy "update own habit data"
  on public.habit_tracker_data for update
  using (auth.uid() = user_id);

-- Required for realtime UPDATE events to actually push to subscribed
-- clients (Supabase realtime only broadcasts changes for tables added to
-- this publication).
alter publication supabase_realtime add table public.habit_tracker_data;

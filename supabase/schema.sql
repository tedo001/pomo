-- Pomo — Supabase schema.
--
-- Run once in your project's SQL editor (Dashboard → SQL Editor → New query → Run).
-- Creates one table per synced collection plus row-level security so each signed-in
-- user only ever sees their own rows.
--
-- Design notes:
--   * `id` is a client-generated uuid, not a serial. Records are created offline and
--     reference each other immediately; a server-assigned key would need a rewrite pass.
--   * `updated_at` is epoch milliseconds (bigint), matching the client's clock exactly.
--     A postgres `timestamptz` would round-trip through two conversions and break the
--     `> since` watermark comparison that the whole incremental pull depends on.
--   * `deleted_at` is a tombstone. Rows are never hard-deleted, or the delete could not
--     propagate to a device that syncs later.
--   * `user_id` defaults to `auth.uid()` so the client never sends it.

create extension if not exists "pgcrypto";

-- Shared columns for every synced table.
create or replace function pomo_touch_defaults() returns void language sql as $$ select 1 $$;

create table if not exists pomo_areas (
  id                    uuid primary key,
  user_id               uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at            bigint not null,
  updated_at            bigint not null,
  deleted_at            bigint,
  name                  text not null default '',
  color                 text not null default '#ff6b5a',
  weekly_target_minutes integer not null default 0,
  archived              boolean not null default false,
  sort_order            bigint not null default 0
);

create table if not exists pomo_projects (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at bigint not null,
  updated_at bigint not null,
  deleted_at bigint,
  area_id    uuid,
  name       text not null default '',
  notes      text not null default '',
  status     text not null default 'active',
  due_at     bigint,
  sort_order bigint not null default 0
);

create table if not exists pomo_tasks (
  id                 uuid primary key,
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at         bigint not null,
  updated_at         bigint not null,
  deleted_at         bigint,
  project_id         uuid,
  area_id            uuid,
  title              text not null default '',
  notes              text not null default '',
  status             text not null default 'todo',
  priority           text not null default 'normal',
  estimate_pomodoros integer not null default 0,
  done_pomodoros     integer not null default 0,
  due_at             bigint,
  completed_at       bigint,
  sort_order         bigint not null default 0
);

create table if not exists pomo_sessions (
  id            uuid primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at    bigint not null,
  updated_at    bigint not null,
  deleted_at    bigint,
  kind          text not null default 'focus',
  task_id       uuid,
  project_id    uuid,
  area_id       uuid,
  started_at    bigint not null,
  ended_at      bigint,
  planned_ms    bigint not null default 0,
  actual_ms     bigint not null default 0,
  completed     boolean not null default false,
  interruptions integer not null default 0,
  note          text not null default '',
  day_key       text not null
);

create table if not exists pomo_habits (
  id             uuid primary key,
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at     bigint not null,
  updated_at     bigint not null,
  deleted_at     bigint,
  area_id        uuid,
  name           text not null default '',
  motivation     text not null default '',
  color          text not null default '#3ecf8e',
  cadence        text not null default 'daily',
  weekdays       jsonb not null default '[]'::jsonb,
  times_per_week integer not null default 7,
  unit           text not null default '',
  target_value   numeric not null default 0,
  archived       boolean not null default false,
  sort_order     bigint not null default 0
);

create table if not exists pomo_habitEntries (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at bigint not null,
  updated_at bigint not null,
  deleted_at bigint,
  habit_id   uuid not null,
  day_key    text not null,
  value      numeric not null default 0,
  note       text not null default ''
);

create table if not exists pomo_journalEntries (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at bigint not null,
  updated_at bigint not null,
  deleted_at bigint,
  day_key    text not null,
  title      text not null default '',
  body       text not null default '',
  mood       integer,
  energy     integer,
  tags       jsonb not null default '[]'::jsonb,
  wins       text not null default '',
  blockers   text not null default '',
  tomorrow   text not null default ''
);

create table if not exists pomo_activity (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at bigint not null,
  updated_at bigint not null,
  deleted_at bigint,
  at         bigint not null,
  day_key    text not null,
  type       text not null,
  entity     text not null,
  entity_id  uuid,
  summary    text not null default '',
  meta       jsonb not null default '{}'::jsonb
);

-- Every incremental pull is `where updated_at > $since order by updated_at`, scoped to
-- the caller's rows. Without these it becomes a sequential scan as history accumulates.
create index if not exists pomo_areas_sync          on pomo_areas (user_id, updated_at);
create index if not exists pomo_projects_sync       on pomo_projects (user_id, updated_at);
create index if not exists pomo_tasks_sync          on pomo_tasks (user_id, updated_at);
create index if not exists pomo_sessions_sync       on pomo_sessions (user_id, updated_at);
create index if not exists pomo_habits_sync         on pomo_habits (user_id, updated_at);
create index if not exists pomo_habitentries_sync   on pomo_habitEntries (user_id, updated_at);
create index if not exists pomo_journalentries_sync on pomo_journalEntries (user_id, updated_at);
create index if not exists pomo_activity_sync       on pomo_activity (user_id, updated_at);

-- Reporting queries the app runs constantly group by day.
create index if not exists pomo_sessions_day on pomo_sessions (user_id, day_key);

-- Row-level security: without this, the anon key would expose every user's journal.
do $$
declare
  target text;
begin
  foreach target in array array[
    'pomo_areas', 'pomo_projects', 'pomo_tasks', 'pomo_sessions',
    'pomo_habits', 'pomo_habitEntries', 'pomo_journalEntries', 'pomo_activity'
  ] loop
    execute format('alter table %I enable row level security', target);
    execute format('drop policy if exists "own rows" on %I', target);
    execute format(
      'create policy "own rows" on %I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())',
      target
    );
  end loop;
end $$;

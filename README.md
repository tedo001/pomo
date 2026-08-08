# Pomo

A pomodoro timer, task tracker, habit tracker and journal in one application — built so
that the time you spend actually leaves a record you can read back months later.

Local-first: everything works offline, in your browser, with no account. When you want
your data on more than one device, point it at **Supabase** or at the **local storage
server** bundled in this repo. Switching between them is a setting, not a rewrite.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

That's it — the app is fully usable at this point. Data lives in your browser's
IndexedDB. Nothing leaves the device until you configure a backend.

```bash
npm run build        # production build into dist/
npm run preview      # serve the production build
npm test             # unit tests
node scripts/smoke.mjs   # full end-to-end run in a real browser
```

---

## What's in it

**Focus timer.** Configurable focus / short break / long break, cycle tracking, auto-start,
a chime and a desktop notification when a block ends, and a distraction counter you can hit
without stopping the clock. The countdown is derived from wall-clock timestamps, so
backgrounding the tab or sleeping the machine doesn't lose minutes, and a running session
survives a reload or a crash.

**Tasks, projects and areas.** *Areas* are the durable parts of your life and career
("Engineering", "Health", "Side project"); *projects* live inside them; *tasks* are the
concrete next things. Attach a task to a session and your focus time gets attributed all
the way up, which is what makes the charts mean something.

**Habits.** Daily (with a weekday schedule) or weekly (N times per week), yes/no or
measured ("20 pages", "5 km"). Streaks, a contribution-style grid, and a completion rate
that only counts days the habit was actually scheduled and actually existed.

**Journal.** One entry per day: headline, free-write, mood and energy, plus dedicated
Wins / Blockers / Tomorrow fields so the career-relevant parts stay queryable rather than
buried in prose. Alongside each entry you get that day's measured numbers and a timestamped
trail of everything that happened.

**Insights.** Focus time per day, where the time went by area, what hour of the day you
actually focus best, session completion rate, consistency, and progress against weekly
per-area targets.

**Your data stays yours.** Full JSON export and import at any time, independent of whether
you've configured a backend.

---

## Where your data lives

Pick one in **Settings → Where your data lives**. All three are the same app; only the
sync target changes.

### 1. This device only (default)

IndexedDB in your browser. No account, no network, works on a plane. Use **Export backup**
to move it somewhere else.

### 2. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor → New query**, paste [`supabase/schema.sql`](supabase/schema.sql), run it.
   It creates the tables, the sync indexes, and row-level security so each signed-in user
   only ever sees their own rows.
3. In Pomo: **Settings → Supabase**, paste your project URL and anon key, hit
   **Test connection**.

### 3. Local storage server

A single-file Node server in [`server/index.js`](server/index.js) — standard library only,
no dependencies, stores everything in one SQLite file on your machine.

```bash
npm run server                                   # http://localhost:4000
POMO_PORT=4000 POMO_TOKEN=secret npm run server  # require a bearer token
```

Then **Settings → Local storage server**, enter the URL (and token, if you set one).

| Variable | Default | Meaning |
| --- | --- | --- |
| `POMO_PORT` | `4000` | Port to listen on |
| `POMO_TOKEN` | *(none)* | If set, requests must send `Authorization: Bearer <token>` |
| `POMO_DATA` | `server/data/pomo.sqlite` | SQLite file path |

### Bring your own backend

The client talks to any server implementing three endpoints:

```
GET  /health                                 -> { ok: true, name: string }
GET  /records/:table?since=<epochMs>&limit=n -> { rows: Record[] }
POST /records/:table  { rows: Record[] }     -> upsert by id
```

`:table` is one of `areas`, `projects`, `tasks`, `sessions`, `habits`, `habitEntries`,
`journalEntries`, `activity`. Implement those and Pomo will sync to it — see
[`src/lib/sync/rest-adapter.ts`](src/lib/sync/rest-adapter.ts).

---

## How it's built

```
src/
  lib/                  domain model, storage, sync, pure logic
    types.ts            every entity, one file
    db.ts               Dexie/IndexedDB schema
    repository.ts       the single write path — timestamps, dirty flags, audit trail
    timer-machine.ts    timer state as pure data + pure transitions
    analytics.ts        streaks, rollups, completion rates (pure, tested)
    backup.ts           export / import
    sync/
      adapter.ts        the two-verb backend contract
      supabase-adapter.ts
      rest-adapter.ts
      sync-engine.ts    push-then-pull, last-write-wins
  store/                zustand stores (settings, timer, sync status)
  features/             one folder per screen
server/index.js         the bundled local storage server
supabase/schema.sql     the Supabase schema
scripts/smoke.mjs       end-to-end browser run
```

A few decisions worth knowing about, because they shape everything else:

**IndexedDB is the source of truth.** A backend is a replica the sync engine reconciles
against, never something the UI blocks on. This is why the app works offline by default
rather than as a fallback mode.

**The timer is derived from timestamps, not ticks.** A timer that decrements a counter on
an interval loses minutes when the browser throttles background tabs. A pomodoro app that
quietly under-counts a 25-minute block is worse than none at all, because you trust the
number.

**Deletes are soft.** A hard delete can't propagate to another device, so every removal
writes a tombstone instead. This is also why importing a backup can't resurrect things you
deleted.

**Sessions are written when they start, not when they finish.** A run cut short by a crash
or a closed laptop still leaves a trace, with `endedAt` null marking it unfinished.

**Conflicts resolve last-write-wins.** An explicit tradeoff: this is single-user,
multi-device data where simultaneous edits to the same row are rare, and the loser is a
habit note or a task title. Sessions — the records that actually matter — are append-only
and immutable once ended, so they can't lose a merge.

**Counters are derived, never incremented.** A task's pomodoro count is recomputed from its
sessions, so a deleted session can't leave a task claiming work that no longer exists.

---

## Testing

```bash
npm test                 # 37 unit tests: timer math, analytics, sync engine
node scripts/smoke.mjs   # 21 end-to-end checks in a real browser
SMOKE_SHOTS=1 node scripts/smoke.mjs   # ...and write screenshots to .smoke/
```

The smoke run boots the production build and the local server, then drives the real UI:
creates an area and a task, runs and reloads a live session, checks a habit in, writes a
journal entry, renders the charts against seeded history, syncs to the server, and confirms
a second browser profile pulls the same data down.

---

## License

MIT

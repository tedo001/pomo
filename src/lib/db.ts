import Dexie, { type EntityTable } from "dexie";
import {
  DEFAULT_SETTINGS,
  type ActivityEvent,
  type Area,
  type Habit,
  type HabitEntry,
  type JournalEntry,
  type Project,
  type Session,
  type Settings,
  type Task,
} from "./types";

/**
 * IndexedDB is the source of truth. The app is fully usable with no backend at all;
 * a remote, when configured, is a replica the sync engine reconciles against — never a
 * dependency the UI blocks on.
 *
 * Index notes: IndexedDB cannot index booleans, which is why `dirty` is `0 | 1` — the
 * push query is `where("dirty").equals(1)`, a range scan rather than a table walk.
 * `[habitId+dayKey]` backs the one-check-in-per-habit-per-day lookup.
 */
export class PomoDatabase extends Dexie {
  areas!: EntityTable<Area, "id">;
  projects!: EntityTable<Project, "id">;
  tasks!: EntityTable<Task, "id">;
  sessions!: EntityTable<Session, "id">;
  habits!: EntityTable<Habit, "id">;
  habitEntries!: EntityTable<HabitEntry, "id">;
  journalEntries!: EntityTable<JournalEntry, "id">;
  activity!: EntityTable<ActivityEvent, "id">;
  settings!: EntityTable<Settings, "id">;

  constructor(name = "pomo") {
    super(name);
    this.version(1).stores({
      areas: "id, updatedAt, dirty, sortOrder, archived",
      projects: "id, updatedAt, dirty, areaId, status, sortOrder",
      tasks: "id, updatedAt, dirty, projectId, areaId, status, dueAt, sortOrder",
      sessions: "id, updatedAt, dirty, dayKey, startedAt, taskId, projectId, areaId, kind",
      habits: "id, updatedAt, dirty, areaId, archived, sortOrder",
      habitEntries: "id, updatedAt, dirty, habitId, dayKey, [habitId+dayKey]",
      journalEntries: "id, updatedAt, dirty, dayKey",
      activity: "id, updatedAt, dirty, at, dayKey, type, entity",
      settings: "id",
    });
  }
}

export const db = new PomoDatabase();

/**
 * Reads settings, seeding the singleton on first run. Spread over defaults so a build
 * that adds a setting doesn't hand `undefined` to an existing install — the alternative
 * is a migration per field, which is not worth it for a flat preferences row.
 */
export async function loadSettings(database: PomoDatabase = db): Promise<Settings> {
  const stored = await database.settings.get("settings");
  if (!stored) {
    const seeded = { ...DEFAULT_SETTINGS, updatedAt: Date.now() };
    await database.settings.put(seeded);
    return seeded;
  }
  return { ...DEFAULT_SETTINGS, ...stored, id: "settings" };
}

export async function saveSettings(
  patch: Partial<Omit<Settings, "id">>,
  database: PomoDatabase = db,
): Promise<Settings> {
  const current = await loadSettings(database);
  const next: Settings = { ...current, ...patch, id: "settings", updatedAt: Date.now() };
  await database.settings.put(next);
  return next;
}

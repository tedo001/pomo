import { db, type PomoDatabase } from "./db";
import { newId } from "./id";
import { dayKeyOf } from "./time";
import type { ActivityEvent, ActivityType, BaseRecord, Id, SyncedTable } from "./types";

/**
 * The single write path for every synced collection.
 *
 * Three invariants live here and nowhere else, because duplicating them across features
 * is how local-first apps end up with rows that never sync or deletes that resurrect:
 *   1. `updatedAt` is stamped on every mutation — it is the conflict-resolution key.
 *   2. `dirty` is set on every mutation — a row the remote has not seen is never clean.
 *   3. Deletes are soft. Hard deletes are unreachable from the UI by design.
 */

export interface AuditContext {
  /** Human-readable line for the activity feed. Omit to skip the audit row. */
  summary?: string;
  meta?: ActivityEvent["meta"];
  /** Local day boundary; passed through from settings so the feed groups correctly. */
  dayStartHour?: number;
}

type Draft<T extends BaseRecord> = Omit<T, keyof BaseRecord> & Partial<Pick<T, "id">>;
type Patch<T extends BaseRecord> = Partial<Omit<T, keyof BaseRecord>>;

export interface Repository<T extends BaseRecord> {
  table: SyncedTable;
  create(draft: Draft<T>, audit?: AuditContext): Promise<T>;
  update(id: Id, patch: Patch<T>, audit?: AuditContext): Promise<T | undefined>;
  remove(id: Id, audit?: AuditContext): Promise<void>;
  get(id: Id): Promise<T | undefined>;
  /** Live rows only — tombstones are an implementation detail of sync. */
  all(): Promise<T[]>;
}

export function createRepository<T extends BaseRecord>(
  table: SyncedTable,
  database: PomoDatabase = db,
): Repository<T> {
  // Dexie's generated table types are per-entity; the generic wrapper needs the loose view.
  const store = () => database.table(table) as unknown as import("dexie").Table<T, Id>;

  return {
    table,

    async create(draft, audit) {
      const now = Date.now();
      const record = {
        ...(draft as object),
        id: (draft as { id?: Id }).id ?? newId(),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        dirty: 1,
      } as T;
      await store().put(record);
      await writeAudit(database, "created", table, record.id, audit);
      return record;
    },

    async update(id, patch, audit) {
      const existing = await store().get(id);
      if (!existing || existing.deletedAt !== null) return undefined;
      const next = { ...existing, ...patch, updatedAt: Date.now(), dirty: 1 } as T;
      await store().put(next);
      await writeAudit(database, "updated", table, id, audit);
      return next;
    },

    async remove(id, audit) {
      const existing = await store().get(id);
      if (!existing || existing.deletedAt !== null) return;
      const now = Date.now();
      // Tombstone, not a delete: the remote learns about removals the same way it
      // learns about edits, and a device that syncs later still drops the row.
      await store().put({ ...existing, deletedAt: now, updatedAt: now, dirty: 1 });
      await writeAudit(database, "deleted", table, id, audit);
    },

    async get(id) {
      const record = await store().get(id);
      return record && record.deletedAt === null ? record : undefined;
    },

    async all() {
      const rows = await store().toArray();
      return rows.filter((row) => row.deletedAt === null);
    },
  };
}

/**
 * Appends to the audit trail. Written as its own row rather than derived from record
 * history so that "I finished 4 sessions on Tuesday" survives later edits to those rows.
 */
export async function writeAudit(
  database: PomoDatabase,
  type: ActivityType,
  entity: string,
  entityId: Id | null,
  audit?: AuditContext,
): Promise<void> {
  if (!audit?.summary) return;
  const now = Date.now();
  const event: ActivityEvent = {
    id: newId(),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    dirty: 1,
    at: now,
    dayKey: dayKeyOf(now, audit.dayStartHour ?? 0),
    type,
    entity,
    entityId,
    summary: audit.summary,
    meta: audit.meta ?? {},
  };
  await database.activity.put(event);
}

export const areasRepo = createRepository<import("./types").Area>("areas");
export const projectsRepo = createRepository<import("./types").Project>("projects");
export const tasksRepo = createRepository<import("./types").Task>("tasks");
export const sessionsRepo = createRepository<import("./types").Session>("sessions");
export const habitsRepo = createRepository<import("./types").Habit>("habits");
export const habitEntriesRepo = createRepository<import("./types").HabitEntry>("habitEntries");
export const journalRepo = createRepository<import("./types").JournalEntry>("journalEntries");

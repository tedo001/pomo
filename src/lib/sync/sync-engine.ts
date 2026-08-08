import { db, loadSettings, saveSettings, type PomoDatabase } from "../db";
import { SYNCED_TABLES, type BaseRecord, type Settings, type SyncedTable } from "../types";
import { fromRemoteRow, localOnlyAdapter, toRemoteRow, type RemoteAdapter } from "./adapter";
import { RestAdapter } from "./rest-adapter";
import { SupabaseAdapter } from "./supabase-adapter";

export interface SyncReport {
  ok: boolean;
  pushed: number;
  pulled: number;
  applied: number;
  startedAt: number;
  finishedAt: number;
  adapter: string;
  errors: string[];
}

export function adapterFor(settings: Settings): RemoteAdapter {
  if (settings.syncMode === "supabase" && settings.supabaseUrl && settings.supabaseAnonKey) {
    return new SupabaseAdapter(settings.supabaseUrl, settings.supabaseAnonKey);
  }
  if (settings.syncMode === "rest" && settings.restUrl) {
    return new RestAdapter(settings.restUrl, settings.restToken);
  }
  return localOnlyAdapter;
}

/**
 * Bidirectional sync, push-then-pull, last-write-wins on `updatedAt`.
 *
 * LWW is an explicit tradeoff, not an oversight: this is single-user, multi-device data
 * where concurrent edits to the *same* row are rare and the loser is a habit note or a
 * task title, never accounting. Sessions — the records that actually matter — are
 * append-only and immutable after they end, so they cannot lose a merge. Buying more
 * than this (vector clocks, CRDTs) would cost more complexity than the failure mode is
 * worth; if that changes, the seam to widen is this function, not the adapters.
 */
export class SyncEngine {
  private running: Promise<SyncReport> | null = null;

  constructor(private readonly database: PomoDatabase = db) {}

  /** Coalesces concurrent callers onto one in-flight run rather than racing pushes. */
  sync(): Promise<SyncReport> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  /** Seam for tests and for future backends chosen by something other than settings. */
  protected buildAdapter(settings: Settings): RemoteAdapter {
    return adapterFor(settings);
  }

  private async run(): Promise<SyncReport> {
    const startedAt = Date.now();
    const settings = await loadSettings(this.database);
    const adapter = this.buildAdapter(settings);
    const report: SyncReport = {
      ok: true,
      pushed: 0,
      pulled: 0,
      applied: 0,
      startedAt,
      finishedAt: startedAt,
      adapter: adapter.name,
      errors: [],
    };

    if (adapter === localOnlyAdapter) {
      report.finishedAt = Date.now();
      return report;
    }

    let watermark = settings.lastPulledAt;

    for (const table of SYNCED_TABLES) {
      try {
        report.pushed += await this.pushTable(adapter, table);
        const pull = await this.pullTable(adapter, table, settings.lastPulledAt);
        report.pulled += pull.pulled;
        report.applied += pull.applied;
        watermark = Math.max(watermark, pull.watermark);
      } catch (cause) {
        report.ok = false;
        report.errors.push(cause instanceof Error ? cause.message : String(cause));
      }
    }

    // Only advance the watermark on a clean run. A partial failure that moved it would
    // permanently skip the rows the failed table never delivered.
    if (report.ok && watermark > settings.lastPulledAt) {
      await saveSettings({ lastPulledAt: watermark }, this.database);
    }

    report.finishedAt = Date.now();
    return report;
  }

  private table(name: SyncedTable) {
    return this.database.table(name) as unknown as import("dexie").Table<BaseRecord, string>;
  }

  private async pushTable(adapter: RemoteAdapter, table: SyncedTable): Promise<number> {
    const pending = await this.table(table).where("dirty").equals(1).toArray();
    if (pending.length === 0) return 0;

    await adapter.push(table, pending.map(toRemoteRow));

    // Clear `dirty` per row, and only if the row has not changed since we read it.
    // An edit landing mid-push must stay dirty or the next sync would drop it.
    const store = this.table(table);
    await this.database.transaction("rw", store, async () => {
      for (const sent of pending) {
        const current = await store.get(sent.id);
        if (current && current.updatedAt === sent.updatedAt) {
          await store.put({ ...current, dirty: 0 });
        }
      }
    });
    return pending.length;
  }

  private async pullTable(
    adapter: RemoteAdapter,
    table: SyncedTable,
    since: number,
  ): Promise<{ pulled: number; applied: number; watermark: number }> {
    const store = this.table(table);
    let cursor = since;
    let pulled = 0;
    let applied = 0;
    let watermark = since;

    // Page until a short page. Bounded so a remote whose clock makes `updatedAt`
    // non-advancing can never turn this into an infinite loop.
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const rows = await adapter.pull(table, cursor);
      if (rows.length === 0) break;
      pulled += rows.length;

      for (const row of rows) {
        watermark = Math.max(watermark, row.updatedAt);
        const local = await store.get(row.id);
        // Ties keep the local row: re-applying an identical remote copy would only
        // churn IndexedDB and invalidate live queries for no observable change.
        if (local && local.updatedAt >= row.updatedAt) continue;
        await store.put(fromRemoteRow(row));
        applied += 1;
      }

      if (rows.length < PULL_PAGE_HINT) break;
      const nextCursor = watermark;
      if (nextCursor <= cursor) break;
      cursor = nextCursor;
    }

    return { pulled, applied, watermark };
  }
}

const MAX_PULL_PAGES = 100;
const PULL_PAGE_HINT = 1000;

export const syncEngine = new SyncEngine();

/** Counts rows still owed to the remote — drives the "N pending" badge. */
export async function pendingChangeCount(database: PomoDatabase = db): Promise<number> {
  const counts = await Promise.all(
    SYNCED_TABLES.map((table) =>
      (database.table(table) as unknown as import("dexie").Table<BaseRecord, string>)
        .where("dirty")
        .equals(1)
        .count(),
    ),
  );
  return counts.reduce((sum, n) => sum + n, 0);
}

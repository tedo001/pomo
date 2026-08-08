import { db, loadSettings } from "./db";
import { SYNCED_TABLES, type BaseRecord, type SyncedTable } from "./types";

/**
 * Whole-database export and import.
 *
 * Independent of the sync layer on purpose: a backend is optional, so "get my data out"
 * cannot depend on having configured one. The file is plain JSON with a version tag, so
 * it stays readable by anything, including a future importer that has to migrate it.
 */

export const BACKUP_VERSION = 1;

export interface BackupFile {
  version: number;
  exportedAt: number;
  app: "pomo";
  tables: Partial<Record<SyncedTable, BaseRecord[]>>;
}

export async function exportBackup(): Promise<BackupFile> {
  const tables: BackupFile["tables"] = {};
  for (const table of SYNCED_TABLES) {
    // Tombstones are included: a restore that dropped them would resurrect rows the
    // user deleted, on every device that later syncs with this one.
    tables[table] = (await db.table(table).toArray()) as BaseRecord[];
  }
  return { version: BACKUP_VERSION, exportedAt: Date.now(), app: "pomo", tables };
}

export async function downloadBackup(): Promise<void> {
  const backup = await exportBackup();
  const settings = await loadSettings();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `pomo-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  void settings;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  tables: string[];
}

/**
 * Merges a backup into the local database, newest-wins per row.
 *
 * A merge rather than a replace: importing on a device that has since done real work
 * must not silently discard it. Imported rows are marked dirty so a configured backend
 * receives everything the restore brought in.
 */
export async function importBackup(file: BackupFile): Promise<ImportResult> {
  if (file.app !== "pomo" || typeof file.version !== "number") {
    throw new Error("Not a Pomo backup file.");
  }
  if (file.version > BACKUP_VERSION) {
    throw new Error(`Backup is version ${file.version}; this build reads up to ${BACKUP_VERSION}.`);
  }

  let imported = 0;
  let skipped = 0;
  const touched: string[] = [];

  for (const table of SYNCED_TABLES) {
    const rows = file.tables[table];
    if (!rows?.length) continue;
    touched.push(table);
    const store = db.table(table) as unknown as import("dexie").Table<BaseRecord, string>;
    await db.transaction("rw", store, async () => {
      for (const row of rows) {
        if (!row?.id || typeof row.updatedAt !== "number") {
          skipped += 1;
          continue;
        }
        const local = await store.get(row.id);
        if (local && local.updatedAt >= row.updatedAt) {
          skipped += 1;
          continue;
        }
        await store.put({ ...row, dirty: 1 });
        imported += 1;
      }
    });
  }

  return { imported, skipped, tables: touched };
}

export async function readBackupFile(file: File): Promise<BackupFile> {
  const text = await file.text();
  return JSON.parse(text) as BackupFile;
}

/** Drops every synced collection. Used by the explicit "erase local data" action only. */
export async function eraseLocalData(): Promise<void> {
  for (const table of SYNCED_TABLES) {
    await db.table(table).clear();
  }
}

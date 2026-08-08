import type { BaseRecord, SyncedTable } from "../types";

/**
 * The contract every backend implements. Deliberately tiny: two verbs over a table of
 * timestamped rows. Anything that can store JSON keyed by id and answer "what changed
 * since T" can back this app — Supabase and the bundled local server are just the two
 * implementations that ship.
 */
export interface RemoteAdapter {
  readonly name: string;
  /** Rows with `updatedAt > since`, tombstones included. Ordering is the caller's problem. */
  pull(table: SyncedTable, since: number): Promise<RemoteRow[]>;
  /** Upsert by id. Must be idempotent — a retried push replays the same rows. */
  push(table: SyncedTable, rows: RemoteRow[]): Promise<void>;
  /** Cheap reachability probe for the settings screen. */
  healthCheck(): Promise<HealthResult>;
}

/** Wire shape: a record minus the local-only `dirty` bookkeeping. */
export type RemoteRow = Omit<BaseRecord, "dirty"> & Record<string, unknown>;

export type HealthResult = { ok: true; detail: string } | { ok: false; detail: string };

export function toRemoteRow<T extends BaseRecord>(record: T): RemoteRow {
  const { dirty: _dirty, ...rest } = record;
  return rest as RemoteRow;
}

export function fromRemoteRow<T extends BaseRecord>(row: RemoteRow): T {
  // Rows arriving from the remote are by definition already there — never dirty.
  return { ...row, dirty: 0 } as unknown as T;
}

/**
 * Local-only mode. A null object rather than a nullable adapter, so the engine has one
 * code path and "no backend" is not a special case sprinkled through call sites.
 */
export const localOnlyAdapter: RemoteAdapter = {
  name: "local",
  async pull() {
    return [];
  },
  async push() {},
  async healthCheck() {
    return { ok: true, detail: "Local-only — data stays in this browser." };
  },
};

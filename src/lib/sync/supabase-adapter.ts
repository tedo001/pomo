import type { SupabaseClient } from "@supabase/supabase-js";
import type { HealthResult, RemoteAdapter, RemoteRow } from "./adapter";
import type { SyncedTable } from "../types";

/**
 * Supabase backend.
 *
 * The client is imported lazily: `@supabase/supabase-js` is the single largest
 * dependency here, and an install that never configures Supabase should never pay to
 * download it. Table names are prefixed so the schema can share a project with
 * unrelated tables.
 */
const TABLE_PREFIX = "pomo_";

/** Postgres columns are snake_case; the domain model is camelCase. Mapped in one place. */
const COLUMN_OF: Record<string, string> = {
  createdAt: "created_at",
  updatedAt: "updated_at",
  deletedAt: "deleted_at",
  areaId: "area_id",
  projectId: "project_id",
  taskId: "task_id",
  habitId: "habit_id",
  dayKey: "day_key",
  startedAt: "started_at",
  endedAt: "ended_at",
  plannedMs: "planned_ms",
  actualMs: "actual_ms",
  dueAt: "due_at",
  completedAt: "completed_at",
  sortOrder: "sort_order",
  weeklyTargetMinutes: "weekly_target_minutes",
  estimatePomodoros: "estimate_pomodoros",
  donePomodoros: "done_pomodoros",
  timesPerWeek: "times_per_week",
  targetValue: "target_value",
  entityId: "entity_id",
};
const FIELD_OF: Record<string, string> = Object.fromEntries(
  Object.entries(COLUMN_OF).map(([field, column]) => [column, field]),
);

function toColumns(row: RemoteRow): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [COLUMN_OF[key] ?? key, value]));
}

function toFields(row: Record<string, unknown>): RemoteRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [FIELD_OF[key] ?? key, value]),
  ) as RemoteRow;
}

export class SupabaseAdapter implements RemoteAdapter {
  readonly name = "supabase";
  private client: SupabaseClient | null = null;

  constructor(
    private readonly url: string,
    private readonly anonKey: string,
  ) {}

  private async connect(): Promise<SupabaseClient> {
    if (this.client) return this.client;
    const { createClient } = await import("@supabase/supabase-js");
    this.client = createClient(this.url, this.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    return this.client;
  }

  async pull(table: SyncedTable, since: number): Promise<RemoteRow[]> {
    const client = await this.connect();
    const { data, error } = await client
      .from(TABLE_PREFIX + table)
      .select("*")
      .gt("updated_at", since)
      .order("updated_at", { ascending: true })
      .limit(PULL_PAGE_SIZE);
    if (error) throw new Error(`Supabase pull(${table}): ${error.message}`);
    return (data ?? []).map(toFields);
  }

  async push(table: SyncedTable, rows: RemoteRow[]): Promise<void> {
    if (rows.length === 0) return;
    const client = await this.connect();
    // Chunked because PostgREST rejects oversized payloads, and a first sync from a
    // long-used install can carry thousands of sessions in one go.
    for (let i = 0; i < rows.length; i += PUSH_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + PUSH_CHUNK_SIZE).map(toColumns);
      const { error } = await client.from(TABLE_PREFIX + table).upsert(chunk, { onConflict: "id" });
      if (error) throw new Error(`Supabase push(${table}): ${error.message}`);
    }
  }

  async healthCheck(): Promise<HealthResult> {
    try {
      const client = await this.connect();
      const { error } = await client.from(`${TABLE_PREFIX}areas`).select("id").limit(1);
      if (error) return { ok: false, detail: error.message };
      return { ok: true, detail: "Connected. Schema reachable." };
    } catch (cause) {
      return { ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
    }
  }
}

/** One round-trip's worth. The engine loops until a page comes back short. */
export const PULL_PAGE_SIZE = 1000;
const PUSH_CHUNK_SIZE = 500;

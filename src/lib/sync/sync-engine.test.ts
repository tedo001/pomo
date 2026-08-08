import { beforeEach, describe, expect, it } from "vitest";
import { PomoDatabase, saveSettings } from "../db";
import { createRepository } from "../repository";
import { SyncEngine, pendingChangeCount } from "./sync-engine";
import type { RemoteAdapter, RemoteRow } from "./adapter";
import type { Area, SyncedTable } from "../types";

/** In-memory stand-in for a backend. Records calls so ordering can be asserted. */
class FakeRemote implements RemoteAdapter {
  readonly name = "fake";
  readonly store = new Map<SyncedTable, Map<string, RemoteRow>>();
  readonly calls: string[] = [];
  failOn: SyncedTable | null = null;

  private tableOf(table: SyncedTable): Map<string, RemoteRow> {
    let rows = this.store.get(table);
    if (!rows) {
      rows = new Map();
      this.store.set(table, rows);
    }
    return rows;
  }

  seed(table: SyncedTable, row: RemoteRow): void {
    this.tableOf(table).set(row.id, row);
  }

  async pull(table: SyncedTable, since: number): Promise<RemoteRow[]> {
    this.calls.push(`pull:${table}`);
    if (this.failOn === table) throw new Error(`pull failed for ${table}`);
    return [...this.tableOf(table).values()].filter((row) => row.updatedAt > since);
  }

  async push(table: SyncedTable, rows: RemoteRow[]): Promise<void> {
    this.calls.push(`push:${table}`);
    if (this.failOn === table) throw new Error(`push failed for ${table}`);
    for (const row of rows) this.tableOf(table).set(row.id, row);
  }

  async healthCheck() {
    return { ok: true as const, detail: "fake" };
  }
}

function remoteArea(id: string, name: string, updatedAt: number, deletedAt: number | null = null): RemoteRow {
  return {
    id,
    createdAt: 1,
    updatedAt,
    deletedAt,
    name,
    color: "#fff",
    weeklyTargetMinutes: 0,
    archived: false,
    sortOrder: 0,
  } as RemoteRow;
}

/** Injects the recording fake through the engine's adapter seam. */
class TestEngine extends SyncEngine {
  constructor(
    db: PomoDatabase,
    private readonly adapter: RemoteAdapter,
  ) {
    super(db);
  }
  protected override buildAdapter(): RemoteAdapter {
    return this.adapter;
  }
}

let database: PomoDatabase;
let remote: FakeRemote;
let areas: ReturnType<typeof createRepository<Area>>;
let counter = 0;

beforeEach(async () => {
  // A fresh named database per test — Dexie instances share storage by name, and a
  // leaked row between cases would make these assertions order-dependent.
  database = new PomoDatabase(`sync-test-${counter++}`);
  await database.open();
  remote = new FakeRemote();
  areas = createRepository<Area>("areas", database);
  await saveSettings({ syncMode: "rest", restUrl: "http://fake" }, database);
});

describe("sync engine", () => {
  it("pushes dirty rows and marks them clean", async () => {
    const engineUnderTest = new TestEngine(database, remote);
    const area = await areas.create({
      name: "Career",
      color: "#f00",
      weeklyTargetMinutes: 300,
      archived: false,
      sortOrder: 0,
    });
    expect(await pendingChangeCount(database)).toBe(1);

    const report = await engineUnderTest.sync();

    expect(report.ok).toBe(true);
    expect(report.pushed).toBe(1);
    expect(remote.store.get("areas")?.get(area.id)?.name).toBe("Career");
    expect(await pendingChangeCount(database)).toBe(0);
  });

  it("never sends the local-only dirty flag to the remote", async () => {
    const engineUnderTest = new TestEngine(database, remote);
    const area = await areas.create({
      name: "Health",
      color: "#0f0",
      weeklyTargetMinutes: 0,
      archived: false,
      sortOrder: 0,
    });
    await engineUnderTest.sync();
    expect(remote.store.get("areas")?.get(area.id)).not.toHaveProperty("dirty");
  });

  it("applies remote rows that are newer than the local copy", async () => {
    const engineUnderTest = new TestEngine(database, remote);
    const area = await areas.create({
      name: "Old name",
      color: "#f00",
      weeklyTargetMinutes: 0,
      archived: false,
      sortOrder: 0,
    });
    await engineUnderTest.sync();

    remote.seed("areas", remoteArea(area.id, "New name", Date.now() + 10_000));
    const report = await engineUnderTest.sync();

    expect(report.applied).toBe(1);
    expect((await areas.get(area.id))?.name).toBe("New name");
    // A row that arrived from the remote is already there — it must not be re-pushed.
    expect(await pendingChangeCount(database)).toBe(0);
  });

  it("keeps the local row when it is newer, and pushes it instead", async () => {
    const engineUnderTest = new TestEngine(database, remote);
    const area = await areas.create({
      name: "Local wins",
      color: "#f00",
      weeklyTargetMinutes: 0,
      archived: false,
      sortOrder: 0,
    });
    remote.seed("areas", remoteArea(area.id, "Stale remote", area.updatedAt - 5_000));

    await engineUnderTest.sync();

    expect((await areas.get(area.id))?.name).toBe("Local wins");
    expect(remote.store.get("areas")?.get(area.id)?.name).toBe("Local wins");
  });

  it("propagates a delete as a tombstone rather than dropping the row", async () => {
    const engineUnderTest = new TestEngine(database, remote);
    const area = await areas.create({
      name: "Doomed",
      color: "#f00",
      weeklyTargetMinutes: 0,
      archived: false,
      sortOrder: 0,
    });
    await engineUnderTest.sync();
    await areas.remove(area.id);
    await engineUnderTest.sync();

    const pushed = remote.store.get("areas")?.get(area.id);
    expect(pushed?.deletedAt).toBeTypeOf("number");
    // Locally the row is gone from reads but still present for future syncs.
    expect(await areas.get(area.id)).toBeUndefined();
    expect(await database.areas.get(area.id)).toBeDefined();
  });

  it("applies an incoming tombstone", async () => {
    const engineUnderTest = new TestEngine(database, remote);
    const area = await areas.create({
      name: "Deleted elsewhere",
      color: "#f00",
      weeklyTargetMinutes: 0,
      archived: false,
      sortOrder: 0,
    });
    await engineUnderTest.sync();

    remote.seed("areas", remoteArea(area.id, "Deleted elsewhere", Date.now() + 10_000, Date.now() + 10_000));
    await engineUnderTest.sync();

    expect(await areas.get(area.id)).toBeUndefined();
  });

  it("does not advance the watermark when a table fails", async () => {
    const engineUnderTest = new TestEngine(database, remote);
    remote.failOn = "tasks";
    remote.seed("areas", remoteArea("a1", "Arrived", Date.now() + 10_000));

    const report = await engineUnderTest.sync();

    expect(report.ok).toBe(false);
    expect(report.errors.some((message) => message.includes("tasks"))).toBe(true);
    // The failing table never delivered its rows; moving the watermark would skip them
    // permanently on the next run.
    const settings = await database.settings.get("settings");
    expect(settings?.lastPulledAt).toBe(0);
    // Other tables still made progress in this pass.
    expect((await areas.get("a1"))?.name).toBe("Arrived");
  });

  it("coalesces concurrent callers onto a single run", async () => {
    const engineUnderTest = new TestEngine(database, remote);
    await areas.create({ name: "A", color: "#f00", weeklyTargetMinutes: 0, archived: false, sortOrder: 0 });

    const [first, second] = await Promise.all([engineUnderTest.sync(), engineUnderTest.sync()]);

    expect(first).toBe(second);
    expect(remote.calls.filter((call) => call === "push:areas")).toHaveLength(1);
  });

  it("is a no-op in local-only mode", async () => {
    await saveSettings({ syncMode: "local" }, database);
    const localEngine = new SyncEngine(database);
    await areas.create({ name: "A", color: "#f00", weeklyTargetMinutes: 0, archived: false, sortOrder: 0 });

    const report = await localEngine.sync();

    expect(report.adapter).toBe("local");
    expect(report.pushed).toBe(0);
    // Rows stay dirty so they are pushed if a backend is configured later.
    expect(await pendingChangeCount(database)).toBe(1);
  });
});

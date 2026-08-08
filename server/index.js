#!/usr/bin/env node
/**
 * Pomo local storage server.
 *
 * A single-file sync target you run on your own machine: no account, no cloud, no
 * dependencies outside Node's standard library. It stores each record as a JSON blob
 * keyed by id, alongside the two columns sync actually queries on — `updated_at` for the
 * incremental pull, and the table name for routing. Keeping the payload opaque means
 * adding a field to the client needs no server migration.
 *
 *   node server/index.js
 *   POMO_PORT=4000 POMO_TOKEN=secret POMO_DATA=./server/data node server/index.js
 *
 * Endpoints (the contract `RestAdapter` speaks):
 *   GET  /health
 *   GET  /records/:table?since=<epochMs>&limit=<n>  -> { rows: [...] }
 *   POST /records/:table  { rows: [...] }           -> { upserted: n }
 */

import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.POMO_PORT ?? 4000);
const TOKEN = process.env.POMO_TOKEN ?? "";
const DATA_PATH = resolve(process.env.POMO_DATA ?? "server/data/pomo.sqlite");
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Mirrors SYNCED_TABLES on the client. An unknown table is rejected, not created. */
const TABLES = new Set([
  "areas",
  "projects",
  "tasks",
  "sessions",
  "habits",
  "habitEntries",
  "journalEntries",
  "activity",
]);

mkdirSync(dirname(DATA_PATH), { recursive: true });
const db = new DatabaseSync(DATA_PATH);

// WAL lets a read overlap the client's write burst on first sync instead of blocking.
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS records (
    table_name TEXT NOT NULL,
    id         TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    payload    TEXT NOT NULL,
    PRIMARY KEY (table_name, id)
  );
`);
// The pull query is exactly this predicate; without the index it degrades to a scan
// of every record ever written once the history gets long.
db.exec("CREATE INDEX IF NOT EXISTS records_by_updated ON records (table_name, updated_at)");

const selectSince = db.prepare(
  "SELECT payload FROM records WHERE table_name = ? AND updated_at > ? ORDER BY updated_at ASC LIMIT ?",
);
const upsert = db.prepare(`
  INSERT INTO records (table_name, id, updated_at, deleted_at, payload)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (table_name, id) DO UPDATE SET
    updated_at = excluded.updated_at,
    deleted_at = excluded.deleted_at,
    payload    = excluded.payload
  WHERE excluded.updated_at > records.updated_at
`);
const countAll = db.prepare("SELECT COUNT(*) AS n FROM records");

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    // The client is a static build that may be served from any port or file host.
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  response.end(payload);
}

function authorized(request) {
  if (!TOKEN) return true;
  return request.headers.authorization === `Bearer ${TOKEN}`;
}

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      // Bound the buffer so one oversized request cannot exhaust memory.
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Body is not valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "OPTIONS") return send(response, 204, {});

  if (url.pathname === "/health") {
    const { n } = countAll.get() ?? { n: 0 };
    return send(response, 200, { ok: true, name: "pomo-local-server", records: n, data: DATA_PATH });
  }

  if (!authorized(request)) return send(response, 401, { error: "Bad or missing bearer token" });

  const match = url.pathname.match(/^\/records\/([A-Za-z]+)$/);
  if (!match) return send(response, 404, { error: "Not found" });

  const table = match[1];
  if (!TABLES.has(table)) return send(response, 400, { error: `Unknown table “${table}”` });

  if (request.method === "GET") {
    const since = Number(url.searchParams.get("since") ?? 0) || 0;
    const limit = Math.min(5000, Number(url.searchParams.get("limit") ?? 1000) || 1000);
    const rows = selectSince.all(table, since, limit).map((row) => JSON.parse(row.payload));
    return send(response, 200, { rows });
  }

  if (request.method === "POST") {
    let body;
    try {
      body = await readBody(request);
    } catch (cause) {
      return send(response, 400, { error: cause.message });
    }
    const rows = Array.isArray(body.rows) ? body.rows : [];
    let upserted = 0;
    let rejected = 0;

    // One transaction for the batch: a first sync can be thousands of rows, and
    // committing each individually is both slow and non-atomic.
    db.exec("BEGIN");
    try {
      for (const row of rows) {
        if (!row || typeof row.id !== "string" || typeof row.updatedAt !== "number") {
          rejected += 1;
          continue;
        }
        // The `WHERE excluded.updated_at > records.updated_at` guard makes this
        // last-write-wins server-side too, so a retried or out-of-order push from a
        // second device cannot roll a newer row backwards.
        upsert.run(table, row.id, row.updatedAt, row.deletedAt ?? null, JSON.stringify(row));
        upserted += 1;
      }
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      return send(response, 500, { error: String(cause?.message ?? cause) });
    }

    return send(response, 200, { upserted, rejected });
  }

  return send(response, 405, { error: "Method not allowed" });
});

server.listen(PORT, () => {
  console.log(`Pomo local server on http://localhost:${PORT}`);
  console.log(`  data:  ${DATA_PATH}`);
  console.log(`  token: ${TOKEN ? "required" : "none (set POMO_TOKEN to require one)"}`);
  console.log(`\nIn the app: Settings → Where your data lives → Local storage server.`);
});

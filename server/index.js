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
 * It also serves the built app from `dist/` when that directory exists, so a self-hosted
 * install is one process on one port rather than a dev server plus an API — and being
 * same-origin means the browser never has to be talked into a cross-origin request.
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
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";

// node:sqlite arrived in Node 22.5 and stopped needing a flag in 22.13 / 23.4. Without
// this guard an older Node fails with an opaque "cannot find module" for a builtin.
let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  console.error(
    `Pomo's server needs Node 22.13+ (or 23.4+) for the built-in SQLite module.\n` +
      `This is ${process.version}. On Arch Linux: sudo pacman -S nodejs`,
  );
  process.exit(1);
}

const PORT = Number(process.env.POMO_PORT ?? 4000);
const TOKEN = process.env.POMO_TOKEN ?? "";
const DATA_PATH = resolve(process.env.POMO_DATA ?? "server/data/pomo.sqlite");
const STATIC_ROOT = resolve(process.env.POMO_STATIC ?? "dist");
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

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

/**
 * Serves the built app. Single-page routing means an unknown path falls back to
 * index.html rather than 404ing, and the resolved path is checked to stay inside
 * STATIC_ROOT so `GET /../../etc/passwd` cannot escape the directory.
 */
function serveStatic(pathname, response) {
  if (!existsSync(STATIC_ROOT)) {
    return send(response, 404, {
      error: "No built app to serve. Run `npm run build`, or use `npm run dev` for the dev server.",
    });
  }

  const requested = resolve(join(STATIC_ROOT, decodeURIComponent(pathname)));
  const inside = requested === STATIC_ROOT || requested.startsWith(STATIC_ROOT + sep);
  let file = inside && existsSync(requested) && statSync(requested).isFile() ? requested : null;
  if (!file) file = join(STATIC_ROOT, "index.html");
  if (!existsSync(file)) return send(response, 404, { error: "Not found" });

  const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
  // Vite fingerprints asset filenames, so those are immutable; index.html must not be
  // cached or a rebuild would keep serving the old bundle references.
  const cacheControl = file.includes(`${sep}assets${sep}`)
    ? "public, max-age=31536000, immutable"
    : "no-cache";

  response.writeHead(200, { "content-type": type, "cache-control": cacheControl });
  createReadStream(file).pipe(response);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "OPTIONS") return send(response, 204, {});

  if (url.pathname === "/health") {
    const { n } = countAll.get() ?? { n: 0 };
    return send(response, 200, { ok: true, name: "pomo-local-server", records: n, data: DATA_PATH });
  }

  const match = url.pathname.match(/^\/records\/([A-Za-z]+)$/);
  // Anything that is not an API route is the app itself. Served before the token check
  // on purpose: the page has to load before the user can enter a token in it.
  if (!match) return serveStatic(url.pathname, response);

  if (!authorized(request)) return send(response, 401, { error: "Bad or missing bearer token" });

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
  const servingApp = existsSync(STATIC_ROOT);
  console.log(`Pomo server on http://localhost:${PORT}`);
  console.log(`  data:  ${DATA_PATH}`);
  console.log(`  token: ${TOKEN ? "required" : "none (set POMO_TOKEN to require one)"}`);
  console.log(`  app:   ${servingApp ? STATIC_ROOT : "not built — run `npm run build` to serve it from here"}`);
  console.log(
    servingApp
      ? `\nOpen http://localhost:${PORT} and set Settings → Where your data lives → Local storage server\nto http://localhost:${PORT}.`
      : `\nIn the app: Settings → Where your data lives → Local storage server.`,
  );
});

import type { HealthResult, RemoteAdapter, RemoteRow } from "./adapter";
import type { SyncedTable } from "../types";

/**
 * Generic HTTP backend — this is what the bundled `server/` speaks, and the seam for
 * pointing the app at your own storage server without touching the client.
 *
 * Three endpoints, no framework assumptions:
 *   GET  {base}/health
 *   GET  {base}/records/:table?since=<epochMs>  -> { rows: RemoteRow[] }
 *   POST {base}/records/:table                  -> { rows: RemoteRow[] } upsert by id
 */
export class RestAdapter implements RemoteAdapter {
  readonly name = "rest";
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    // A trailing slash here produces `//records` paths that some servers 404 on.
    this.base = baseUrl.replace(/\/+$/, "");
  }

  private headers(): HeadersInit {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(this.base + path, { ...init, headers: this.headers() });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status} ${body.slice(0, 200)}`);
    }
    return response.json();
  }

  async pull(table: SyncedTable, since: number): Promise<RemoteRow[]> {
    const payload = (await this.request(
      `/records/${table}?since=${since}&limit=${PULL_PAGE_SIZE}`,
    )) as { rows?: RemoteRow[] };
    return payload.rows ?? [];
  }

  async push(table: SyncedTable, rows: RemoteRow[]): Promise<void> {
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += PUSH_CHUNK_SIZE) {
      await this.request(`/records/${table}`, {
        method: "POST",
        body: JSON.stringify({ rows: rows.slice(i, i + PUSH_CHUNK_SIZE) }),
      });
    }
  }

  async healthCheck(): Promise<HealthResult> {
    try {
      const payload = (await this.request("/health")) as { ok?: boolean; name?: string };
      if (!payload.ok) return { ok: false, detail: "Server responded but reported not-ok." };
      return { ok: true, detail: `Connected to ${payload.name ?? "server"}.` };
    } catch (cause) {
      return { ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
    }
  }
}

export const PULL_PAGE_SIZE = 1000;
const PUSH_CHUNK_SIZE = 500;

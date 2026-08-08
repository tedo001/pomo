import { useRef, useState } from "react";
import { AlertTriangle, Check, Cloud, Download, HardDrive, RefreshCw, Server, Upload } from "lucide-react";
import clsx from "clsx";
import { downloadBackup, eraseLocalData, importBackup, readBackupFile } from "../../lib/backup";
import { adapterFor } from "../../lib/sync/sync-engine";
import { requestNotificationPermission } from "../../lib/notify";
import { formatDuration } from "../../lib/time";
import { useSettings } from "../../store/settings-store";
import { useSync } from "../../store/sync-store";
import { Badge, Button, Card, Field, Input, SectionTitle, Select } from "../../components/ui";
import type { SyncMode } from "../../lib/types";

const SYNC_MODES: { mode: SyncMode; title: string; body: string; icon: typeof Cloud }[] = [
  {
    mode: "local",
    title: "This device only",
    body: "Everything stays in your browser's database. No account, no network, works offline. Export a backup to move it.",
    icon: HardDrive,
  },
  {
    mode: "supabase",
    title: "Supabase",
    body: "Sync to a Postgres project you own. Run the bundled schema.sql once, paste your project URL and anon key.",
    icon: Cloud,
  },
  {
    mode: "rest",
    title: "Local storage server",
    body: "Sync to the server bundled in this repo, or anything speaking the same three endpoints, on your own machine.",
    icon: Server,
  },
];

export function SettingsPage() {
  const { settings, update } = useSettings();
  const sync = useSync();
  const [probe, setProbe] = useState<{ ok: boolean; detail: string } | null>(null);
  const [probing, setProbing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function testConnection() {
    setProbing(true);
    setProbe(null);
    try {
      setProbe(await adapterFor(settings).healthCheck());
    } finally {
      setProbing(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <Card>
        <SectionTitle>Timer</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Focus (minutes)">
            <Input
              type="number"
              min={1}
              max={180}
              value={settings.focusMinutes}
              onChange={(event) => void update({ focusMinutes: clampMinutes(event.target.value, 25) })}
            />
          </Field>
          <Field label="Short break">
            <Input
              type="number"
              min={1}
              max={60}
              value={settings.shortBreakMinutes}
              onChange={(event) => void update({ shortBreakMinutes: clampMinutes(event.target.value, 5) })}
            />
          </Field>
          <Field label="Long break">
            <Input
              type="number"
              min={1}
              max={120}
              value={settings.longBreakMinutes}
              onChange={(event) => void update({ longBreakMinutes: clampMinutes(event.target.value, 15) })}
            />
          </Field>
          <Field label="Long break every" hint="focus sessions">
            <Input
              type="number"
              min={1}
              max={12}
              value={settings.longBreakEvery}
              onChange={(event) => void update({ longBreakEvery: clampMinutes(event.target.value, 4) })}
            />
          </Field>
          <Field label="Daily goal" hint="focus sessions">
            <Input
              type="number"
              min={1}
              max={40}
              value={settings.dailyGoalPomodoros}
              onChange={(event) => void update({ dailyGoalPomodoros: clampMinutes(event.target.value, 8) })}
            />
          </Field>
          <Field label="Day starts at" hint="For night owls — 4 means 3am counts as yesterday.">
            <Select
              value={String(settings.dayStartHour)}
              onChange={(event) => void update({ dayStartHour: Number(event.target.value) })}
            >
              {Array.from({ length: 12 }, (_, hour) => (
                <option key={hour} value={hour}>
                  {String(hour).padStart(2, "0")}:00
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="mt-4 space-y-2">
          <Toggle
            label="Auto-start breaks"
            checked={settings.autoStartBreaks}
            onChange={(autoStartBreaks) => void update({ autoStartBreaks })}
          />
          <Toggle
            label="Auto-start the next focus session"
            checked={settings.autoStartFocus}
            onChange={(autoStartFocus) => void update({ autoStartFocus })}
          />
          <Toggle
            label="Chime when a session ends"
            checked={settings.soundEnabled}
            onChange={(soundEnabled) => void update({ soundEnabled })}
          />
          <Toggle
            label="Desktop notifications"
            checked={settings.notificationsEnabled}
            onChange={async (notificationsEnabled) => {
              // Ask the browser only when switching on; permission prompts are a
              // one-shot resource and firing one on every render burns it.
              if (notificationsEnabled) {
                const granted = await requestNotificationPermission();
                if (!granted) {
                  setNotice("Your browser blocked notifications. The in-app chime still works.");
                  return;
                }
              }
              void update({ notificationsEnabled });
            }}
          />
        </div>
      </Card>

      <Card>
        <SectionTitle
          action={
            <div className="flex items-center gap-2">
              {sync.pending > 0 && <Badge tone="warn">{sync.pending} pending</Badge>}
              <Button size="sm" variant="outline" onClick={() => void sync.syncNow()} disabled={sync.status === "syncing"}>
                <RefreshCw size={14} className={clsx(sync.status === "syncing" && "animate-spin")} /> Sync now
              </Button>
            </div>
          }
        >
          Where your data lives
        </SectionTitle>

        <div className="grid gap-3 sm:grid-cols-3">
          {SYNC_MODES.map(({ mode, title, body, icon: Icon }) => (
            <button
              key={mode}
              type="button"
              onClick={() => void update({ syncMode: mode })}
              className={clsx(
                "rounded-xl border p-4 text-left transition",
                settings.syncMode === mode ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "hover:bg-[var(--surface-2)]",
              )}
            >
              <Icon size={18} className="mb-2 text-[var(--accent)]" />
              <p className="font-medium">{title}</p>
              <p className="mt-1 text-xs text-[var(--muted)]">{body}</p>
            </button>
          ))}
        </div>

        {settings.syncMode === "supabase" && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Project URL">
              <Input
                value={settings.supabaseUrl}
                placeholder="https://xxxx.supabase.co"
                onChange={(event) => void update({ supabaseUrl: event.target.value.trim() })}
              />
            </Field>
            <Field label="Anon key">
              <Input
                type="password"
                value={settings.supabaseAnonKey}
                placeholder="eyJhbGci…"
                onChange={(event) => void update({ supabaseAnonKey: event.target.value.trim() })}
              />
            </Field>
            <p className="text-xs text-[var(--muted)] sm:col-span-2">
              Run <code className="rounded bg-[var(--surface-2)] px-1">supabase/schema.sql</code> in your project&apos;s SQL
              editor first. It creates the tables and row-level security policies.
            </p>
          </div>
        )}

        {settings.syncMode === "rest" && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Server URL">
              <Input
                value={settings.restUrl}
                placeholder="http://localhost:4000"
                onChange={(event) => void update({ restUrl: event.target.value.trim() })}
              />
            </Field>
            <Field label="Token" hint="Optional. Matches POMO_TOKEN on the server.">
              <Input
                type="password"
                value={settings.restToken}
                onChange={(event) => void update({ restToken: event.target.value.trim() })}
              />
            </Field>
            <p className="text-xs text-[var(--muted)] sm:col-span-2">
              Start it with <code className="rounded bg-[var(--surface-2)] px-1">npm run server</code>.
            </p>
          </div>
        )}

        {settings.syncMode !== "local" && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => void testConnection()} disabled={probing}>
              {probing ? "Testing…" : "Test connection"}
            </Button>
            {probe && (
              <span className={clsx("text-sm", probe.ok ? "text-[var(--rest)]" : "text-[var(--accent)]")}>
                {probe.ok ? <Check size={14} className="mr-1 inline" /> : <AlertTriangle size={14} className="mr-1 inline" />}
                {probe.detail}
              </span>
            )}
          </div>
        )}

        {sync.lastReport && (
          <p className="mt-3 text-xs text-[var(--muted)]">
            Last sync via {sync.lastReport.adapter}: pushed {sync.lastReport.pushed}, applied {sync.lastReport.applied}, in{" "}
            {formatDuration(sync.lastReport.finishedAt - sync.lastReport.startedAt)}.
            {sync.lastReport.errors.length > 0 && ` Errors: ${sync.lastReport.errors.join("; ")}`}
          </p>
        )}
      </Card>

      <Card>
        <SectionTitle>Backup</SectionTitle>
        <p className="mb-4 text-sm text-[var(--muted)]">
          A full JSON copy of every area, task, session, habit, journal entry and activity record. Importing merges
          newest-wins, so restoring onto a device that kept working never throws that work away.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={() => void downloadBackup()}>
            <Download size={16} /> Export backup
          </Button>
          <Button variant="outline" onClick={() => fileInput.current?.click()}>
            <Upload size={16} /> Import backup
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              try {
                const result = await importBackup(await readBackupFile(file));
                setNotice(`Imported ${result.imported} records, skipped ${result.skipped} already-current rows.`);
                await sync.refreshPending();
              } catch (cause) {
                setNotice(cause instanceof Error ? cause.message : "Could not read that file.");
              } finally {
                event.target.value = "";
              }
            }}
          />
          <Button
            variant="danger"
            onClick={async () => {
              if (!window.confirm("Erase all local data on this device? Export a backup first if you want to keep it.")) {
                return;
              }
              await eraseLocalData();
              setNotice("Local data erased.");
            }}
          >
            Erase local data
          </Button>
        </div>
        {notice && <p className="mt-3 text-sm text-[var(--muted)]">{notice}</p>}
      </Card>

      <Card>
        <SectionTitle>Appearance</SectionTitle>
        <Field label="Theme">
          <Select
            value={settings.theme}
            onChange={(event) => void update({ theme: event.target.value as typeof settings.theme })}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">Match system</option>
          </Select>
        </Field>
      </Card>
    </div>
  );
}

function clampMinutes(raw: string, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl px-1 py-2 text-sm">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={clsx(
          "relative h-6 w-11 shrink-0 rounded-full transition",
          checked ? "bg-[var(--accent)]" : "bg-[var(--surface-2)] border",
        )}
      >
        <span
          className="absolute top-1 h-4 w-4 rounded-full bg-white transition-[left] duration-200"
          style={{ left: checked ? 24 : 4 }}
        />
      </button>
    </label>
  );
}

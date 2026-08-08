import { Suspense, lazy, useEffect, useState } from "react";
import { BarChart3, BookOpen, CheckSquare, Cloud, CloudOff, ListChecks, Settings as SettingsIcon, Timer } from "lucide-react";
import clsx from "clsx";
import { TimerPage } from "./features/timer/TimerPage";
import { TasksPage } from "./features/tasks/TasksPage";
import { HabitsPage } from "./features/habits/HabitsPage";
import { JournalPage } from "./features/journal/JournalPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { useSettings } from "./store/settings-store";
import { useTimer } from "./store/timer-store";
import { useSync } from "./store/sync-store";
import { formatClock } from "./lib/time";
import { remainingMs } from "./lib/timer-machine";
import { useNow } from "./lib/use-now";

const TABS = [
  { id: "focus", label: "Focus", icon: Timer },
  { id: "tasks", label: "Tasks", icon: CheckSquare },
  { id: "habits", label: "Habits", icon: ListChecks },
  { id: "journal", label: "Journal", icon: BookOpen },
  { id: "insights", label: "Insights", icon: BarChart3 },
  { id: "settings", label: "Settings", icon: SettingsIcon },
] as const;

type TabId = (typeof TABS)[number]["id"];

// Charts pull in the whole plotting library. The app opens on the timer, so that cost
// belongs behind the tab that actually needs it, not in every cold start.
const InsightsPage = lazy(async () => ({
  default: (await import("./features/dashboard/InsightsPage")).InsightsPage,
}));

export default function App() {
  const [tab, setTab] = useState<TabId>("focus");
  const { settings, loaded, hydrate } = useSettings();

  // One boot sequence, ordered: settings first because the timer's durations and the
  // day boundary both read from them, then the persisted timer, then sync.
  useEffect(() => {
    void (async () => {
      await hydrate();
      await useTimer.getState().hydrate();
      void useSync.getState().syncNow();
    })();
  }, [hydrate]);

  useEffect(() => useSync.getState().startAutoSync(), []);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);

  if (!loaded) {
    return (
      <div className="grid h-full place-items-center text-sm text-[var(--muted)]">Loading your data…</div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar tab={tab} onTab={setTab} />
      <main className="flex-1 overflow-y-auto px-4 pb-24 pt-6 sm:px-6 lg:pb-10">
        {tab === "focus" && <TimerPage onGoToTasks={() => setTab("tasks")} />}
        {tab === "tasks" && <TasksPage onStartFocus={() => setTab("focus")} />}
        {tab === "habits" && <HabitsPage />}
        {tab === "journal" && <JournalPage />}
        {tab === "insights" && (
          <Suspense fallback={<p className="text-center text-sm text-[var(--muted)]">Loading charts…</p>}>
            <InsightsPage />
          </Suspense>
        )}
        {tab === "settings" && <SettingsPage />}
      </main>
      <BottomNav tab={tab} onTab={setTab} />
    </div>
  );
}

function TopBar({ tab, onTab }: { tab: TabId; onTab: (tab: TabId) => void }) {
  const timer = useTimer();
  const active = timer.phase === "running" || timer.phase === "paused";
  const now = useNow(1000, active);
  const syncMode = useSettings((s) => s.settings.syncMode);
  const syncStatus = useSync((s) => s.status);
  const pending = useSync((s) => s.pending);

  return (
    <header className="sticky top-0 z-30 border-b bg-[color-mix(in_srgb,var(--bg)_85%,transparent)] backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 sm:px-6">
        <button type="button" onClick={() => onTab("focus")} className="flex shrink-0 items-center gap-2 font-semibold">
          <span aria-hidden="true">🍅</span>
          <span className="hidden sm:inline">Pomo</span>
        </button>

        <nav className="hidden flex-1 items-center gap-1 lg:flex">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onTab(id)}
              className={clsx(
                "inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition",
                tab === id ? "bg-[var(--surface-2)] font-medium" : "text-[var(--muted)] hover:bg-[var(--surface-2)]",
              )}
            >
              <Icon size={16} /> {label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {/* A running timer stays visible from every screen — the app's whole promise
              is that a session is never quietly lost track of. */}
          {active && (
            <button
              type="button"
              onClick={() => onTab("focus")}
              className="tabular inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm"
              title="Back to the timer"
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{
                  background: timer.kind === "focus" ? "var(--focus)" : "var(--rest)",
                  opacity: timer.phase === "paused" ? 0.4 : 1,
                }}
              />
              {formatClock(remainingMs(timer, now))}
            </button>
          )}
          <SyncPill mode={syncMode} status={syncStatus} pending={pending} />
        </div>
      </div>
    </header>
  );
}

function SyncPill({
  mode,
  status,
  pending,
}: {
  mode: string;
  status: string;
  pending: number;
}) {
  const local = mode === "local";
  const label = local ? "On this device" : status === "error" ? "Sync failed" : pending > 0 ? `${pending} pending` : "Synced";
  return (
    <span
      className="hidden items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs text-[var(--muted)] sm:inline-flex"
      title={local ? "Data is stored in this browser only. Configure a backend in Settings." : `Backend: ${mode}`}
    >
      {local ? <CloudOff size={13} /> : <Cloud size={13} className={status === "error" ? "text-[var(--accent)]" : undefined} />}
      {label}
    </span>
  );
}

function BottomNav({ tab, onTab }: { tab: TabId; onTab: (tab: TabId) => void }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] backdrop-blur lg:hidden">
      <div className="flex items-stretch justify-around pb-[env(safe-area-inset-bottom)]">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => onTab(id)}
            className={clsx(
              "flex flex-1 flex-col items-center gap-1 px-1 py-2.5 text-[10px] transition",
              tab === id ? "text-[var(--accent)]" : "text-[var(--muted)]",
            )}
          >
            <Icon size={18} />
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}

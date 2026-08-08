import { useEffect, useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Coffee, Pause, Play, RotateCcw, Square, Target, Zap } from "lucide-react";
import { db } from "../../lib/db";
import { formatClock, formatDuration, todayKey } from "../../lib/time";
import { isElapsed, plannedMsFor, progressRatio, remainingMs } from "../../lib/timer-machine";
import { setTitle } from "../../lib/notify";
import { useNow } from "../../lib/use-now";
import { useSettings } from "../../store/settings-store";
import { useTimer } from "../../store/timer-store";
import { dayStatsFor } from "../../lib/analytics";
import { Badge, Button, Card, EmptyState, Select, Stat } from "../../components/ui";
import type { SessionKind } from "../../lib/types";

const KIND_LABEL: Record<SessionKind, string> = {
  focus: "Focus",
  shortBreak: "Short break",
  longBreak: "Long break",
};

export function TimerPage({ onGoToTasks }: { onGoToTasks: () => void }) {
  const settings = useSettings((s) => s.settings);
  const timer = useTimer();
  const running = timer.phase === "running";
  const now = useNow(250, timer.phase !== "idle");

  const tasks = useLiveQuery(
    async () =>
      (await db.tasks.toArray())
        .filter((task) => task.deletedAt === null && task.status !== "done" && task.status !== "dropped")
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [],
    [],
  );

  const today = todayKey(settings.dayStartHour);
  const todaySessions = useLiveQuery(
    async () => (await db.sessions.where("dayKey").equals(today).toArray()).filter((s) => s.deletedAt === null),
    [today],
    [],
  );

  const stats = useMemo(() => dayStatsFor(todaySessions ?? [], [today])[0], [todaySessions, today]);

  const idlePlanned = plannedMsFor(timer.kind, settings);
  const left = timer.phase === "idle" ? idlePlanned : remainingMs(timer, now);
  const ratio = timer.phase === "idle" ? 0 : progressRatio(timer, now);

  // The countdown reaching zero is what ends a session — the store never trusts a
  // setTimeout that a backgrounded tab may never have fired.
  useEffect(() => {
    if (isElapsed(timer, now)) void useTimer.getState().complete();
  }, [timer, now]);

  useEffect(() => {
    setTitle(
      timer.phase === "running" || timer.phase === "paused"
        ? `${formatClock(left)} · ${KIND_LABEL[timer.kind]} — Pomo`
        : "Pomo — Focus, Habits & Journal",
    );
  }, [left, timer.phase, timer.kind]);

  const activeTask = (tasks ?? []).find((task) => task.id === timer.taskId);
  const goal = Math.max(1, settings.dailyGoalPomodoros);
  const doneToday = stats?.focusCount ?? 0;

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="flex flex-col items-center gap-6 py-10">
        <div className="flex gap-2">
          {(["focus", "shortBreak", "longBreak"] as const).map((kind) => (
            <Button
              key={kind}
              size="sm"
              variant={timer.kind === kind ? "primary" : "ghost"}
              disabled={timer.phase !== "idle"}
              onClick={() => useTimer.setState({ kind })}
              title={timer.phase !== "idle" ? "Stop the current session to switch" : undefined}
            >
              {KIND_LABEL[kind]}
            </Button>
          ))}
        </div>

        <ProgressRing
          ratio={ratio}
          color={timer.kind === "focus" ? "var(--focus)" : "var(--rest)"}
          paused={timer.phase === "paused"}
        >
          <div className="tabular text-6xl font-semibold sm:text-7xl">{formatClock(left)}</div>
          <div className="mt-2 text-sm text-[var(--muted)]">
            {timer.phase === "paused"
              ? "Paused"
              : timer.phase === "running"
                ? activeTask
                  ? activeTask.title
                  : KIND_LABEL[timer.kind]
                : `${Math.round(idlePlanned / 60000)} minute ${KIND_LABEL[timer.kind].toLowerCase()}`}
          </div>
        </ProgressRing>

        <CycleDots done={timer.cycleCount} total={Math.max(1, settings.longBreakEvery)} />

        <div className="flex flex-wrap items-center justify-center gap-3">
          {timer.phase === "idle" && (
            <Button size="lg" variant="primary" onClick={() => void timer.start(timer.kind, timer.taskId)}>
              <Play size={18} /> Start {KIND_LABEL[timer.kind].toLowerCase()}
            </Button>
          )}
          {running && (
            <Button size="lg" variant="outline" onClick={timer.pause}>
              <Pause size={18} /> Pause
            </Button>
          )}
          {timer.phase === "paused" && (
            <Button size="lg" variant="primary" onClick={timer.resume}>
              <Play size={18} /> Resume
            </Button>
          )}
          {timer.phase !== "idle" && (
            <Button size="lg" variant="danger" onClick={() => void timer.stop()}>
              <Square size={18} /> Stop
            </Button>
          )}
          {running && timer.kind === "focus" && (
            <Button
              size="lg"
              variant="ghost"
              onClick={timer.addInterruption}
              title="Log a distraction without stopping the clock"
            >
              <Zap size={18} /> Distracted ({timer.interruptions})
            </Button>
          )}
        </div>

        {timer.pendingNext && (
          <div className="flex items-center gap-3 rounded-xl border bg-[var(--surface-2)] px-4 py-3 text-sm">
            <Coffee size={16} className="text-[var(--rest)]" />
            <span>Up next: {KIND_LABEL[timer.pendingNext].toLowerCase()}</span>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void timer.start(timer.pendingNext!, timer.pendingNext === "focus" ? timer.taskId : null)}
            >
              Start
            </Button>
            <Button size="sm" variant="ghost" onClick={timer.dismissNext}>
              Later
            </Button>
          </div>
        )}
      </Card>

      <div className="space-y-4">
        <Card>
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Target size={16} className="text-[var(--accent)]" /> What are you working on?
          </div>
          {(tasks ?? []).length === 0 ? (
            <EmptyState
              title="No open tasks"
              body="Sessions run fine without one, but linking a task is what turns raw focus time into a record of what you actually moved forward."
              action={
                <Button variant="outline" size="sm" onClick={onGoToTasks}>
                  Add a task
                </Button>
              }
            />
          ) : (
            <Select
              value={timer.taskId ?? ""}
              onChange={(event) => timer.setTask(event.target.value || null)}
              aria-label="Task for this session"
            >
              <option value="">No task — untracked focus</option>
              {(tasks ?? []).map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                  {task.estimatePomodoros > 0 ? ` (${task.donePomodoros}/${task.estimatePomodoros})` : ""}
                </option>
              ))}
            </Select>
          )}
        </Card>

        <div className="grid grid-cols-2 gap-3">
          <Stat label="Today" value={`${doneToday}/${goal}`} sub="sessions" />
          <Stat label="Focus time" value={formatDuration(stats?.focusMs ?? 0)} sub="today" />
        </div>

        <Card>
          <div className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--muted)]">Daily goal</div>
          <div className="h-2 overflow-hidden rounded-full bg-[var(--surface-2)]">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500"
              style={{ width: `${Math.min(100, (doneToday / goal) * 100)}%` }}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {(stats?.abandoned ?? 0) > 0 && <Badge tone="warn">{stats.abandoned} stopped early</Badge>}
            {(stats?.interruptions ?? 0) > 0 && <Badge tone="info">{stats.interruptions} distractions</Badge>}
            {doneToday >= goal && <Badge tone="rest">Goal met</Badge>}
          </div>
        </Card>

        <Card>
          <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
            <RotateCcw size={13} /> Recent
          </div>
          <ul className="space-y-2 text-sm">
            {(todaySessions ?? [])
              .slice()
              .sort((a, b) => b.startedAt - a.startedAt)
              .slice(0, 5)
              .map((session) => (
                <li key={session.id} className="flex items-center justify-between gap-2">
                  <span className="truncate text-[var(--muted)]">
                    {new Date(session.startedAt).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    · {KIND_LABEL[session.kind]}
                  </span>
                  <span className="tabular shrink-0">
                    {session.endedAt === null ? "running" : formatDuration(session.actualMs)}
                  </span>
                </li>
              ))}
            {(todaySessions ?? []).length === 0 && (
              <li className="text-[var(--muted)]">Nothing logged yet today.</li>
            )}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function ProgressRing({
  ratio,
  color,
  paused,
  children,
}: {
  ratio: number;
  color: string;
  paused: boolean;
  children: React.ReactNode;
}) {
  const size = 280;
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
          opacity={paused ? 0.45 : 1}
          style={{ transition: "stroke-dashoffset 250ms linear, opacity 200ms" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}

function CycleDots({ done, total }: { done: number; total: number }) {
  const position = total === 0 ? 0 : done % total;
  return (
    <div className="flex items-center gap-2" title={`${position} of ${total} focus sessions until a long break`}>
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          className="h-2 w-2 rounded-full transition"
          style={{ background: index < position ? "var(--accent)" : "var(--surface-2)" }}
        />
      ))}
      <span className="ml-2 text-xs text-[var(--muted)]">until long break</span>
    </div>
  );
}

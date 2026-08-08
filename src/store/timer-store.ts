import { create } from "zustand";
import { db } from "../lib/db";
import { newId } from "../lib/id";
import { sessionsRepo, tasksRepo, writeAudit } from "../lib/repository";
import { dayKeyOf, formatDuration } from "../lib/time";
import {
  IDLE_TIMER,
  elapsedMs,
  finishTimer,
  nextKindAfter,
  pauseTimer,
  plannedMsFor,
  resumeTimer,
  startTimer,
  type TimerState,
} from "../lib/timer-machine";
import type { SessionKind, Settings, Task } from "../lib/types";
import { notify, playChime } from "../lib/notify";
import { useSettings } from "./settings-store";

const PERSIST_KEY = "pomo.timer.v1";

interface TimerStore extends TimerState {
  /** Set when a run has just ended, so the UI can offer the next block. */
  pendingNext: SessionKind | null;
  hydrate(): Promise<void>;
  start(kind: SessionKind, taskId: string | null): Promise<void>;
  pause(): void;
  resume(): void;
  /** Ends early. The session row is still written, flagged `completed: false`. */
  stop(): Promise<void>;
  /** Ends because the clock ran out. */
  complete(): Promise<void>;
  addInterruption(): void;
  setTask(taskId: string | null): void;
  dismissNext(): void;
}

function persist(state: TimerState): void {
  try {
    const { pendingNext: _ignored, ...rest } = state as TimerState & { pendingNext?: unknown };
    localStorage.setItem(PERSIST_KEY, JSON.stringify(rest));
  } catch {
    // Private-browsing quota failures must not break the timer; the session row in
    // IndexedDB is the durable record, this is only crash recovery for the UI.
  }
}

function readPersisted(): TimerState | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TimerState>;
    if (typeof parsed.phase !== "string") return null;
    return { ...IDLE_TIMER, ...parsed };
  } catch {
    return null;
  }
}

export const useTimer = create<TimerStore>((set, get) => {
  const settingsOf = (): Settings => useSettings.getState().settings;

  /** Writes the session's end state and rolls the task counter. Shared by stop/complete. */
  async function finalize(completed: boolean): Promise<void> {
    const state = get();
    const settings = settingsOf();
    const now = Date.now();

    if (state.sessionId) {
      const actualMs = elapsedMs(state, now);
      await sessionsRepo.update(state.sessionId, {
        endedAt: now,
        // A completed run banks its planned length even if the tab was closed a few
        // seconds late; an abandoned one banks only what was really spent.
        actualMs: completed ? Math.max(actualMs, state.plannedMs) : actualMs,
        completed,
        interruptions: state.interruptions,
      });
      if (state.kind === "focus") {
        await writeAudit(
          db,
          completed ? "completed" : "abandoned",
          "sessions",
          state.sessionId,
          {
            summary: completed
              ? `Completed a ${formatDuration(state.plannedMs)} focus session`
              : `Stopped a focus session after ${formatDuration(actualMs)}`,
            meta: { interruptions: state.interruptions },
            dayStartHour: settings.dayStartHour,
          },
        );
      }
      if (completed && state.kind === "focus" && state.taskId) {
        await recountTaskPomodoros(state.taskId);
      }
    }

    const next = finishTimer(state, completed);
    const offered =
      completed && state.kind === "focus"
        ? nextKindAfter("focus", next.cycleCount, settings)
        : completed
          ? "focus"
          : null;

    set({ ...next, pendingNext: offered });
    persist(next);

    if (completed) {
      if (settings.soundEnabled) playChime(settings.soundVolume);
      if (settings.notificationsEnabled) {
        notify(
          state.kind === "focus" ? "Focus session complete" : "Break over",
          state.kind === "focus" ? "Time for a break." : "Back to work when you're ready.",
        );
      }
      const autoStart =
        (offered !== "focus" && settings.autoStartBreaks) ||
        (offered === "focus" && settings.autoStartFocus);
      if (offered && autoStart) {
        await get().start(offered, offered === "focus" ? state.taskId : null);
      }
    }
  }

  return {
    ...IDLE_TIMER,
    pendingNext: null,

    async hydrate() {
      const restored = readPersisted();
      if (!restored || restored.phase === "idle") return;
      set({ ...restored, pendingNext: null });

      // The app was closed while a timer ran. If the clock has since run out, close the
      // session out honestly instead of resuming a run that ended an hour ago.
      const now = Date.now();
      if (restored.phase === "running" && elapsedMs(restored, now) >= restored.plannedMs) {
        await finalize(true);
      }
    },

    async start(kind, taskId) {
      const settings = settingsOf();
      const state = get();
      if (state.phase === "running" || state.phase === "paused") await finalize(false);

      const now = Date.now();
      const plannedMs = plannedMsFor(kind, settings);
      const sessionId = newId();
      const task = taskId ? await tasksRepo.get(taskId) : undefined;

      // The row is written at *start*, not at end: a run interrupted by a crash or a
      // closed laptop still leaves a trace, with `endedAt` null marking it unfinished.
      await sessionsRepo.create({
        id: sessionId,
        kind,
        taskId: task?.id ?? null,
        projectId: task?.projectId ?? null,
        areaId: task?.areaId ?? null,
        startedAt: now,
        endedAt: null,
        plannedMs,
        actualMs: 0,
        completed: false,
        interruptions: 0,
        note: "",
        dayKey: dayKeyOf(now, settings.dayStartHour),
      } as Parameters<typeof sessionsRepo.create>[0]);

      if (kind === "focus" && task) {
        await tasksRepo.update(task.id, task.status === "todo" ? { status: "doing" } : {});
      }

      const next = startTimer(get(), { kind, sessionId, taskId: task?.id ?? null, plannedMs, now });
      set({ ...next, pendingNext: null });
      persist(next);
    },

    pause() {
      const next = pauseTimer(get(), Date.now());
      set(next);
      persist(next);
    },

    resume() {
      const next = resumeTimer(get(), Date.now());
      set(next);
      persist(next);
    },

    async stop() {
      if (get().phase === "idle") return;
      await finalize(false);
    },

    async complete() {
      if (get().phase !== "running") return;
      await finalize(true);
    },

    addInterruption() {
      set({ interruptions: get().interruptions + 1 });
      persist(get());
    },

    setTask(taskId) {
      set({ taskId });
      persist(get());
      const { sessionId, phase } = get();
      if (sessionId && phase !== "idle") {
        void (async () => {
          const task = taskId ? await tasksRepo.get(taskId) : undefined;
          await sessionsRepo.update(sessionId, {
            taskId: task?.id ?? null,
            projectId: task?.projectId ?? null,
            areaId: task?.areaId ?? null,
          });
        })();
      }
    },

    dismissNext() {
      set({ pendingNext: null });
    },
  };
});

/**
 * Recomputes a task's pomodoro count from its sessions instead of incrementing it.
 * The counter is a cache; deriving it from the session rows means a deleted or edited
 * session can never leave the task showing work that no longer exists.
 */
export async function recountTaskPomodoros(taskId: string): Promise<void> {
  const sessions = await db.sessions.where("taskId").equals(taskId).toArray();
  const donePomodoros = sessions.filter(
    (s) => s.kind === "focus" && s.completed && s.deletedAt === null,
  ).length;
  const task = (await tasksRepo.get(taskId)) as Task | undefined;
  if (task && task.donePomodoros !== donePomodoros) {
    await tasksRepo.update(taskId, { donePomodoros });
  }
}

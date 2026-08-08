import type { SessionKind, Settings } from "./types";
import { minutesToMs } from "./time";

/**
 * Timer state as pure data plus pure transitions.
 *
 * The remaining time is *derived* from wall-clock timestamps, never decremented by a
 * tick. A tick-decrementing timer loses minutes whenever the tab is backgrounded (the
 * browser throttles timers to once a minute or stops them entirely) or the machine
 * sleeps — and a pomodoro app that quietly under-counts a 25-minute block is worse than
 * one that does not exist, because the user trusts the number. Here the interval only
 * decides how often to re-render; the value it renders comes from `Date.now()`.
 */

export type TimerPhase = "idle" | "running" | "paused" | "finished";

export interface TimerState {
  phase: TimerPhase;
  kind: SessionKind;
  /** Id of the `Session` row this run is writing to. Null while idle. */
  sessionId: string | null;
  taskId: string | null;
  /** Wall clock at start. Null while idle. */
  startedAt: number | null;
  plannedMs: number;
  /** Total time spent paused across this run. */
  pausedAccumMs: number;
  /** Wall clock at the current pause, or null when not paused. */
  pausedAt: number | null;
  /** Focus runs completed in the current cycle — decides when a long break is due. */
  cycleCount: number;
  interruptions: number;
}

export const IDLE_TIMER: TimerState = {
  phase: "idle",
  kind: "focus",
  sessionId: null,
  taskId: null,
  startedAt: null,
  plannedMs: 0,
  pausedAccumMs: 0,
  pausedAt: null,
  cycleCount: 0,
  interruptions: 0,
};

export function plannedMsFor(kind: SessionKind, settings: Settings): number {
  const minutes =
    kind === "focus"
      ? settings.focusMinutes
      : kind === "shortBreak"
        ? settings.shortBreakMinutes
        : settings.longBreakMinutes;
  // A zero or negative configured length would make a session that ends the instant it
  // starts; clamp to something a human can actually observe.
  return Math.max(minutesToMs(1), minutesToMs(minutes));
}

/** Time the run has actually been active, excluding every paused stretch. */
export function elapsedMs(state: TimerState, now: number): number {
  if (state.startedAt === null) return 0;
  const pausedNow = state.pausedAt === null ? 0 : now - state.pausedAt;
  return Math.max(0, now - state.startedAt - state.pausedAccumMs - pausedNow);
}

export function remainingMs(state: TimerState, now: number): number {
  if (state.phase === "idle") return state.plannedMs;
  return Math.max(0, state.plannedMs - elapsedMs(state, now));
}

/** 0..1 for the progress ring. Guards the divide so an unstarted run reads as empty. */
export function progressRatio(state: TimerState, now: number): number {
  if (state.plannedMs <= 0) return 0;
  return Math.min(1, elapsedMs(state, now) / state.plannedMs);
}

export function isElapsed(state: TimerState, now: number): boolean {
  return state.phase === "running" && remainingMs(state, now) <= 0;
}

export function startTimer(
  state: TimerState,
  input: { kind: SessionKind; sessionId: string; taskId: string | null; plannedMs: number; now: number },
): TimerState {
  return {
    ...state,
    phase: "running",
    kind: input.kind,
    sessionId: input.sessionId,
    taskId: input.taskId,
    startedAt: input.now,
    plannedMs: input.plannedMs,
    pausedAccumMs: 0,
    pausedAt: null,
    interruptions: 0,
  };
}

export function pauseTimer(state: TimerState, now: number): TimerState {
  if (state.phase !== "running") return state;
  return { ...state, phase: "paused", pausedAt: now };
}

export function resumeTimer(state: TimerState, now: number): TimerState {
  if (state.phase !== "paused" || state.pausedAt === null) return state;
  return {
    ...state,
    phase: "running",
    pausedAccumMs: state.pausedAccumMs + (now - state.pausedAt),
    pausedAt: null,
  };
}

/**
 * Ends the run. `cycleCount` advances only on a *completed focus* run, so abandoning a
 * pomodoro never brings the long break closer — the break is a reward for work done.
 */
export function finishTimer(state: TimerState, completed: boolean): TimerState {
  const advanced = completed && state.kind === "focus" ? state.cycleCount + 1 : state.cycleCount;
  const reset = state.kind === "longBreak" && completed ? 0 : advanced;
  return { ...IDLE_TIMER, cycleCount: reset, phase: "idle" };
}

/** What to offer once `kind` finishes, given how many focus runs are behind us. */
export function nextKindAfter(kind: SessionKind, cycleCount: number, settings: Settings): SessionKind {
  if (kind !== "focus") return "focus";
  const every = Math.max(1, settings.longBreakEvery);
  return cycleCount > 0 && cycleCount % every === 0 ? "longBreak" : "shortBreak";
}

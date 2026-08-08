import { describe, expect, it } from "vitest";
import {
  IDLE_TIMER,
  elapsedMs,
  finishTimer,
  nextKindAfter,
  pauseTimer,
  plannedMsFor,
  progressRatio,
  remainingMs,
  resumeTimer,
  startTimer,
} from "./timer-machine";
import { DEFAULT_SETTINGS } from "./types";

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

function runningAt(start: number, plannedMinutes = 25) {
  return startTimer(IDLE_TIMER, {
    kind: "focus",
    sessionId: "s1",
    taskId: null,
    plannedMs: plannedMinutes * MINUTE,
    now: start,
  });
}

describe("elapsed time", () => {
  it("derives from wall clock, so a gap with no ticks still counts", () => {
    const state = runningAt(T0);
    // Nothing "ticked" between T0 and T0+10min — a backgrounded tab produces exactly
    // this, and the elapsed time must not depend on having been rendered.
    expect(elapsedMs(state, T0 + 10 * MINUTE)).toBe(10 * MINUTE);
    expect(remainingMs(state, T0 + 10 * MINUTE)).toBe(15 * MINUTE);
  });

  it("excludes paused stretches", () => {
    let state = runningAt(T0);
    state = pauseTimer(state, T0 + 5 * MINUTE);
    // Five minutes of wall clock pass while paused; none of them are focus time.
    expect(elapsedMs(state, T0 + 10 * MINUTE)).toBe(5 * MINUTE);
    state = resumeTimer(state, T0 + 10 * MINUTE);
    expect(elapsedMs(state, T0 + 12 * MINUTE)).toBe(7 * MINUTE);
  });

  it("accumulates across repeated pauses", () => {
    let state = runningAt(T0);
    state = pauseTimer(state, T0 + 1 * MINUTE);
    state = resumeTimer(state, T0 + 3 * MINUTE);
    state = pauseTimer(state, T0 + 4 * MINUTE);
    state = resumeTimer(state, T0 + 9 * MINUTE);
    // Ran 1 + 1 minutes, paused 2 + 5.
    expect(elapsedMs(state, T0 + 9 * MINUTE)).toBe(2 * MINUTE);
  });

  it("never reports negative remaining time past the end", () => {
    const state = runningAt(T0);
    expect(remainingMs(state, T0 + 999 * MINUTE)).toBe(0);
    expect(progressRatio(state, T0 + 999 * MINUTE)).toBe(1);
  });

  it("ignores resume when not paused and pause when not running", () => {
    const state = runningAt(T0);
    expect(resumeTimer(state, T0 + MINUTE)).toBe(state);
    expect(pauseTimer(IDLE_TIMER, T0)).toBe(IDLE_TIMER);
  });
});

describe("session lengths", () => {
  it("maps each kind to its configured minutes", () => {
    expect(plannedMsFor("focus", DEFAULT_SETTINGS)).toBe(25 * MINUTE);
    expect(plannedMsFor("shortBreak", DEFAULT_SETTINGS)).toBe(5 * MINUTE);
    expect(plannedMsFor("longBreak", DEFAULT_SETTINGS)).toBe(15 * MINUTE);
  });

  it("clamps a nonsensical configured length to something observable", () => {
    expect(plannedMsFor("focus", { ...DEFAULT_SETTINGS, focusMinutes: 0 })).toBe(MINUTE);
    expect(plannedMsFor("focus", { ...DEFAULT_SETTINGS, focusMinutes: -5 })).toBe(MINUTE);
  });
});

describe("cycle progression", () => {
  it("advances the cycle only when a focus session actually completes", () => {
    const state = runningAt(T0);
    expect(finishTimer(state, true).cycleCount).toBe(1);
    // Abandoning must not bring the long break closer — the break is earned.
    expect(finishTimer(state, false).cycleCount).toBe(0);
  });

  it("does not advance the cycle for breaks", () => {
    const state = { ...runningAt(T0), kind: "shortBreak" as const, cycleCount: 2 };
    expect(finishTimer(state, true).cycleCount).toBe(2);
  });

  it("resets the cycle after a completed long break", () => {
    const state = { ...runningAt(T0), kind: "longBreak" as const, cycleCount: 4 };
    expect(finishTimer(state, true).cycleCount).toBe(0);
  });

  it("offers a long break on the configured interval", () => {
    const settings = { ...DEFAULT_SETTINGS, longBreakEvery: 4 };
    expect(nextKindAfter("focus", 1, settings)).toBe("shortBreak");
    expect(nextKindAfter("focus", 3, settings)).toBe("shortBreak");
    expect(nextKindAfter("focus", 4, settings)).toBe("longBreak");
    expect(nextKindAfter("focus", 8, settings)).toBe("longBreak");
  });

  it("always returns to focus after a break", () => {
    expect(nextKindAfter("shortBreak", 3, DEFAULT_SETTINGS)).toBe("focus");
    expect(nextKindAfter("longBreak", 0, DEFAULT_SETTINGS)).toBe("focus");
  });

  it("survives a zero long-break interval instead of dividing by it", () => {
    expect(nextKindAfter("focus", 3, { ...DEFAULT_SETTINGS, longBreakEvery: 0 })).toBe("longBreak");
  });
});

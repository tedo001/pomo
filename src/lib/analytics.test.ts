import { describe, expect, it } from "vitest";
import { dayStatsFor, focusStreak, habitStats, totalFocusMs } from "./analytics";
import type { Habit, HabitEntry, Session } from "./types";

const MINUTE = 60_000;

function session(partial: Partial<Session>): Session {
  return {
    id: Math.random().toString(36).slice(2),
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    dirty: 0,
    kind: "focus",
    taskId: null,
    projectId: null,
    areaId: null,
    startedAt: 0,
    endedAt: 0,
    plannedMs: 25 * MINUTE,
    actualMs: 25 * MINUTE,
    completed: true,
    interruptions: 0,
    note: "",
    dayKey: "2026-03-10",
    ...partial,
  };
}

function habit(partial: Partial<Habit> = {}): Habit {
  return {
    id: "h1",
    createdAt: new Date(2026, 0, 1).getTime(),
    updatedAt: 0,
    deletedAt: null,
    dirty: 0,
    areaId: null,
    name: "Read",
    motivation: "",
    color: "#000",
    cadence: "daily",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    timesPerWeek: 7,
    unit: "",
    targetValue: 0,
    archived: false,
    sortOrder: 0,
    ...partial,
  };
}

function entry(dayKey: string, value = 1): HabitEntry {
  return {
    id: `e-${dayKey}`,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    dirty: 0,
    habitId: "h1",
    dayKey,
    value,
    note: "",
  };
}

describe("daily rollups", () => {
  it("separates completed focus from abandoned, and focus from breaks", () => {
    const rows = [
      session({ dayKey: "2026-03-10", actualMs: 25 * MINUTE }),
      session({ dayKey: "2026-03-10", actualMs: 7 * MINUTE, completed: false, interruptions: 2 }),
      session({ dayKey: "2026-03-10", kind: "shortBreak", actualMs: 5 * MINUTE }),
    ];
    const [day] = dayStatsFor(rows, ["2026-03-10"]);
    // Abandoned time still counts as focus time spent — it was spent — but not as a
    // completed session. Conflating the two is how these apps flatter their users.
    expect(day.focusMs).toBe(32 * MINUTE);
    expect(day.focusCount).toBe(1);
    expect(day.abandoned).toBe(1);
    expect(day.breakMs).toBe(5 * MINUTE);
    expect(day.interruptions).toBe(2);
  });

  it("returns a zeroed bucket for days with no sessions", () => {
    const [day] = dayStatsFor([], ["2026-03-11"]);
    expect(day).toEqual({
      dayKey: "2026-03-11",
      focusMs: 0,
      focusCount: 0,
      breakMs: 0,
      abandoned: 0,
      interruptions: 0,
    });
  });

  it("ignores sessions outside the requested range", () => {
    const rows = [session({ dayKey: "2026-01-01" })];
    expect(totalFocusMs(rows)).toBe(25 * MINUTE);
    expect(dayStatsFor(rows, ["2026-03-10"])[0].focusMs).toBe(0);
  });
});

describe("focus streak", () => {
  it("counts consecutive days back from today", () => {
    const rows = ["2026-03-10", "2026-03-09", "2026-03-08"].map((dayKey) => session({ dayKey }));
    expect(focusStreak(rows, "2026-03-10")).toBe(3);
  });

  it("does not break the streak just because today has no session yet", () => {
    const rows = ["2026-03-09", "2026-03-08"].map((dayKey) => session({ dayKey }));
    // It is 9am and the user hasn't started. Showing "streak: 0" here would be both
    // wrong and the exact moment people quit a tracker.
    expect(focusStreak(rows, "2026-03-10")).toBe(2);
  });

  it("stops at a genuine gap", () => {
    const rows = ["2026-03-09", "2026-03-06"].map((dayKey) => session({ dayKey }));
    expect(focusStreak(rows, "2026-03-10")).toBe(1);
  });

  it("ignores abandoned sessions", () => {
    const rows = [session({ dayKey: "2026-03-09", completed: false })];
    expect(focusStreak(rows, "2026-03-10")).toBe(0);
  });
});

describe("habit stats", () => {
  it("counts a simple daily streak", () => {
    const entries = ["2026-03-10", "2026-03-09", "2026-03-08"].map((day) => entry(day));
    const stats = habitStats(habit(), entries, "2026-03-10", 30);
    expect(stats.currentStreak).toBe(3);
    expect(stats.bestStreak).toBe(3);
  });

  it("skips unscheduled weekdays instead of breaking the streak", () => {
    // 2026-03-09 is a Monday; schedule Mon/Wed/Fri only.
    const monWedFri = habit({ weekdays: [1, 3, 5] });
    const entries = ["2026-03-09", "2026-03-11", "2026-03-13"].map((day) => entry(day));
    // Saturday the 14th: the untouched Tue/Thu/weekend must not count as misses.
    expect(habitStats(monWedFri, entries, "2026-03-14", 30).currentStreak).toBe(3);
  });

  it("treats an unfinished today as pending, not as a miss", () => {
    const entries = ["2026-03-09", "2026-03-08"].map((day) => entry(day));
    expect(habitStats(habit(), entries, "2026-03-10", 30).currentStreak).toBe(2);
  });

  it("requires the target to be met for quantified habits", () => {
    const reading = habit({ unit: "pages", targetValue: 20 });
    const short = habitStats(reading, [entry("2026-03-10", 12)], "2026-03-10", 30);
    const met = habitStats(reading, [entry("2026-03-10", 25)], "2026-03-10", 30);
    expect(short.currentStreak).toBe(0);
    expect(met.currentStreak).toBe(1);
  });

  it("reports weekly progress for weekly habits only", () => {
    const gym = habit({ cadence: "weekly", timesPerWeek: 3, weekdays: [] });
    // 2026-03-09 Mon, 2026-03-11 Wed — same Monday-start week as Tue 2026-03-10.
    const stats = habitStats(gym, [entry("2026-03-09"), entry("2026-03-11")], "2026-03-10", 30);
    expect(stats.weekProgress).toBe(2);
    expect(habitStats(habit(), [], "2026-03-10", 30).weekProgress).toBeNull();
  });

  it("computes completion rate over scheduled days only", () => {
    const monWedFri = habit({ weekdays: [1, 3, 5] });
    // A 7-day window from Mon 2026-03-09 has 3 scheduled days; one is kept.
    const stats = habitStats(monWedFri, [entry("2026-03-09")], "2026-03-15", 7);
    expect(stats.scheduledDays).toBe(3);
    expect(stats.satisfiedDays).toBe(1);
    expect(stats.completionRate).toBeCloseTo(1 / 3, 5);
  });
});

describe("in-progress sessions", () => {
  it("counts a still-running session as neither finished nor abandoned", () => {
    const running = session({ dayKey: "2026-03-10", endedAt: null, completed: false, actualMs: 0 });
    const [day] = dayStatsFor([running], ["2026-03-10"]);
    // The timer screen reads this while the clock is visibly ticking; calling it
    // "stopped early" would contradict what the user is looking at.
    expect(day.focusCount).toBe(0);
    expect(day.abandoned).toBe(0);
  });
});

describe("habit window", () => {
  it("does not score days before the habit existed", () => {
    const created = new Date(2026, 2, 10).getTime();
    const fresh = habit({ createdAt: created });
    const stats = habitStats(fresh, [entry("2026-03-10")], "2026-03-10", 365);
    // Kept on the only day it has existed — that is 100%, not 0.27%.
    expect(stats.scheduledDays).toBe(1);
    expect(stats.satisfiedDays).toBe(1);
    expect(stats.completionRate).toBe(1);
  });
});

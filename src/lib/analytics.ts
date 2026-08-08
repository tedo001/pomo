import { dayKeyOf, lastNDayKeys, shiftDayKey, weekStartKey, weekdayOf } from "./time";
import type { Habit, HabitEntry, Session } from "./types";

/**
 * Derived metrics. Pure functions over already-loaded rows — no database access — so the
 * numbers on the dashboard are testable without a browser and cannot drift from the
 * numbers on the habit grid.
 */

export interface DayStats {
  dayKey: string;
  focusMs: number;
  focusCount: number;
  breakMs: number;
  abandoned: number;
  interruptions: number;
}

export function dayStatsFor(sessions: Session[], dayKeys: string[]): DayStats[] {
  const byDay = new Map<string, DayStats>(
    dayKeys.map((dayKey) => [
      dayKey,
      { dayKey, focusMs: 0, focusCount: 0, breakMs: 0, abandoned: 0, interruptions: 0 },
    ]),
  );

  for (const session of sessions) {
    const bucket = byDay.get(session.dayKey);
    if (!bucket) continue;
    if (session.kind === "focus") {
      bucket.focusMs += session.actualMs;
      bucket.interruptions += session.interruptions;
      // A session with no `endedAt` is still running. Counting it as abandoned would
      // show "1 stopped early" on the timer screen while the clock is visibly ticking.
      if (session.completed) bucket.focusCount += 1;
      else if (session.endedAt !== null) bucket.abandoned += 1;
    } else {
      bucket.breakMs += session.actualMs;
    }
  }

  return dayKeys.map((dayKey) => byDay.get(dayKey)!);
}

export function totalFocusMs(sessions: Session[]): number {
  return sessions.reduce((sum, s) => (s.kind === "focus" ? sum + s.actualMs : sum), 0);
}

/** Share of focus runs that reached the end. The honest counterweight to raw focus time. */
export function focusCompletionRate(sessions: Session[]): number {
  const focus = sessions.filter((s) => s.kind === "focus");
  if (focus.length === 0) return 0;
  return focus.filter((s) => s.completed).length / focus.length;
}

/** Focus milliseconds grouped by a foreign key (area or project). Nulls bucket under `"none"`. */
export function focusMsByKey(sessions: Session[], key: "areaId" | "projectId"): Map<string, number> {
  const totals = new Map<string, number>();
  for (const session of sessions) {
    if (session.kind !== "focus") continue;
    const bucket = session[key] ?? "none";
    totals.set(bucket, (totals.get(bucket) ?? 0) + session.actualMs);
  }
  return totals;
}

/** Focus milliseconds by hour-of-day (0-23) — surfaces when the user actually focuses well. */
export function focusMsByHour(sessions: Session[]): number[] {
  const hours = new Array<number>(24).fill(0);
  for (const session of sessions) {
    if (session.kind !== "focus") continue;
    hours[new Date(session.startedAt).getHours()] += session.actualMs;
  }
  return hours;
}

export function isHabitScheduled(habit: Habit, dayKey: string): boolean {
  if (habit.cadence === "weekly") return true;
  if (habit.weekdays.length === 0) return true;
  return habit.weekdays.includes(weekdayOf(dayKey));
}

export function isEntrySatisfying(habit: Habit, entry: HabitEntry | undefined): boolean {
  if (!entry) return false;
  if (habit.targetValue > 0) return entry.value >= habit.targetValue;
  return entry.value > 0;
}

export interface HabitStats {
  currentStreak: number;
  bestStreak: number;
  /** Satisfied days over scheduled days in the window. */
  completionRate: number;
  scheduledDays: number;
  satisfiedDays: number;
  /** Present only for `weekly` habits: check-ins so far in the current week. */
  weekProgress: number | null;
}

/**
 * Streaks over the last `windowDays`.
 *
 * Unscheduled days are *skipped*, not counted as misses — a Mon/Wed/Fri habit must not
 * lose its streak every Tuesday. Today is also skipped when still unsatisfied: the day
 * is not over, and showing a streak reset at 9am for a habit the user will do at 6pm is
 * the kind of wrong-and-discouraging feedback that makes people abandon trackers.
 *
 * The window also never reaches back before the habit existed. Scoring a day-old habit
 * against a year of days it could not have been kept reports "0% kept" for someone who
 * has kept it every single time.
 */
export function habitStats(
  habit: Habit,
  entries: HabitEntry[],
  todayDayKey: string,
  windowDays = 365,
): HabitStats {
  const byDay = new Map(entries.map((entry) => [entry.dayKey, entry]));
  const createdDayKey = dayKeyOf(habit.createdAt);
  const window = lastNDayKeys(windowDays, todayDayKey);

  let scheduledDays = 0;
  let satisfiedDays = 0;
  let bestStreak = 0;
  let running = 0;

  for (const dayKey of window) {
    if (dayKey < createdDayKey) continue;
    if (!isHabitScheduled(habit, dayKey)) continue;
    scheduledDays += 1;
    if (isEntrySatisfying(habit, byDay.get(dayKey))) {
      satisfiedDays += 1;
      running += 1;
      bestStreak = Math.max(bestStreak, running);
    } else {
      running = 0;
    }
  }

  let currentStreak = 0;
  let cursor = todayDayKey;
  if (isHabitScheduled(habit, cursor) && !isEntrySatisfying(habit, byDay.get(cursor))) {
    cursor = shiftDayKey(cursor, -1);
  }
  for (let i = 0; i < windowDays; i += 1) {
    if (isHabitScheduled(habit, cursor)) {
      if (!isEntrySatisfying(habit, byDay.get(cursor))) break;
      currentStreak += 1;
    }
    cursor = shiftDayKey(cursor, -1);
  }

  const thisWeek = weekStartKey(todayDayKey);
  const weekProgress =
    habit.cadence === "weekly"
      ? entries.filter(
          (entry) => weekStartKey(entry.dayKey) === thisWeek && isEntrySatisfying(habit, entry),
        ).length
      : null;

  return {
    currentStreak,
    bestStreak,
    completionRate: scheduledDays === 0 ? 0 : satisfiedDays / scheduledDays,
    scheduledDays,
    satisfiedDays,
    weekProgress,
  };
}

/** Consecutive days ending today with at least one completed focus session. */
export function focusStreak(sessions: Session[], todayDayKey: string, windowDays = 365): number {
  const active = new Set(
    sessions.filter((s) => s.kind === "focus" && s.completed).map((s) => s.dayKey),
  );
  let cursor = todayDayKey;
  // Today not yet worked is "not over", not a broken streak — same reasoning as habits.
  if (!active.has(cursor)) cursor = shiftDayKey(cursor, -1);
  let streak = 0;
  for (let i = 0; i < windowDays && active.has(cursor); i += 1) {
    streak += 1;
    cursor = shiftDayKey(cursor, -1);
  }
  return streak;
}

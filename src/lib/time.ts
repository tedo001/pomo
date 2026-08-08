/**
 * Local-day arithmetic.
 *
 * Everything the app rolls up — streaks, heatmaps, daily goals — groups on a `dayKey`
 * rather than a raw timestamp. The key is derived in *local* time and shifted by the
 * user's `dayStartHour`, so a session finished at 01:30 by someone whose day starts at
 * 04:00 still counts toward the previous day. Deriving this in one place is what keeps
 * the timer, the habit grid, and the charts from disagreeing about what "today" means.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` in local time, shifted back by `dayStartHour`. */
export function dayKeyOf(at: number | Date, dayStartHour = 0): string {
  const shifted = new Date((at instanceof Date ? at.getTime() : at) - dayStartHour * MS_PER_HOUR);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, "0");
  const d = String(shifted.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayKey(dayStartHour = 0): string {
  return dayKeyOf(Date.now(), dayStartHour);
}

/** Midnight-local `Date` for a `YYYY-MM-DD` key. Parsed manually because `new Date("2026-01-01")` is UTC. */
export function dateFromDayKey(dayKey: string): Date {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function shiftDayKey(dayKey: string, days: number): string {
  const date = dateFromDayKey(dayKey);
  date.setDate(date.getDate() + days);
  return dayKeyOf(date, 0);
}

/** Inclusive list of day keys from `from` to `to`. */
export function dayKeyRange(from: string, to: string): string[] {
  const keys: string[] = [];
  let cursor = from;
  // Bounded so a reversed or malformed range can never spin.
  for (let i = 0; i < 4000 && cursor <= to; i += 1) {
    keys.push(cursor);
    cursor = shiftDayKey(cursor, 1);
  }
  return keys;
}

/** The last `count` day keys ending at `endKey`, oldest first. */
export function lastNDayKeys(count: number, endKey: string): string[] {
  return dayKeyRange(shiftDayKey(endKey, -(count - 1)), endKey);
}

/** 0=Sun..6=Sat for a day key. */
export function weekdayOf(dayKey: string): number {
  return dateFromDayKey(dayKey).getDay();
}

/** Monday-start week key (`YYYY-MM-DD` of that Monday). */
export function weekStartKey(dayKey: string): string {
  const date = dateFromDayKey(dayKey);
  const offset = (date.getDay() + 6) % 7;
  return shiftDayKey(dayKey, -offset);
}

/** `mm:ss`, or `h:mm:ss` past an hour. Always positive — a negative remainder clamps to zero. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Compact human duration for summaries: `2h 15m`, `45m`, `30s`. */
export function formatDuration(ms: number): string {
  if (ms < MS_PER_MINUTE) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const totalMinutes = Math.round(ms / MS_PER_MINUTE);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export function formatDayLabel(dayKey: string, today = todayKey()): string {
  if (dayKey === today) return "Today";
  if (dayKey === shiftDayKey(today, -1)) return "Yesterday";
  if (dayKey === shiftDayKey(today, 1)) return "Tomorrow";
  return dateFromDayKey(dayKey).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function minutesToMs(minutes: number): number {
  return Math.round(minutes * MS_PER_MINUTE);
}

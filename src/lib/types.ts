/**
 * Domain model.
 *
 * Every syncable record carries `updatedAt` and a nullable `deletedAt`. Deletes are
 * soft: a hard delete cannot propagate to another device, so the tombstone *is* the
 * delete. `dirty` is local-only bookkeeping — it marks rows the sync engine still owes
 * the remote, and is stripped before anything leaves the device.
 */

export type Id = string;

export interface BaseRecord {
  id: Id;
  createdAt: number;
  updatedAt: number;
  /** Tombstone. Non-null means deleted; the row stays so the delete can sync. */
  deletedAt: number | null;
  /** Local-only: 1 = pending push. Indexed, so the push query is a range scan. */
  dirty: 0 | 1;
}

/** A life or career area — the top-level bucket everything else hangs off. */
export interface Area extends BaseRecord {
  name: string;
  color: string;
  /** Weekly focus-time target in minutes. 0 = untracked. */
  weeklyTargetMinutes: number;
  archived: boolean;
  sortOrder: number;
}

export interface Project extends BaseRecord {
  areaId: Id | null;
  name: string;
  notes: string;
  status: ProjectStatus;
  /** Optional deadline (epoch ms) for career milestones. */
  dueAt: number | null;
  sortOrder: number;
}

export const PROJECT_STATUSES = ["active", "paused", "done", "dropped"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface Task extends BaseRecord {
  projectId: Id | null;
  areaId: Id | null;
  title: string;
  notes: string;
  status: TaskStatus;
  priority: Priority;
  /** Planned pomodoros. 0 = unestimated. */
  estimatePomodoros: number;
  /** Denormalised counter, recomputed from sessions — see `recountTaskPomodoros`. */
  donePomodoros: number;
  dueAt: number | null;
  completedAt: number | null;
  sortOrder: number;
}

export const TASK_STATUSES = ["todo", "doing", "done", "dropped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ["low", "normal", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const SESSION_KINDS = ["focus", "shortBreak", "longBreak"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/**
 * The traceability spine: one row per timer run, written whether it completed or was
 * abandoned. Analytics never infer focus time from anything else.
 */
export interface Session extends BaseRecord {
  kind: SessionKind;
  taskId: Id | null;
  projectId: Id | null;
  areaId: Id | null;
  startedAt: number;
  endedAt: number | null;
  /** Planned length. Kept even when abandoned, so completion rate is measurable. */
  plannedMs: number;
  /** Time actually spent running, excluding paused stretches. */
  actualMs: number;
  completed: boolean;
  /** Self-reported distractions during the run. */
  interruptions: number;
  note: string;
  /** Local day key `YYYY-MM-DD`, indexed — every daily rollup groups on this. */
  dayKey: string;
}

export const HABIT_CADENCES = ["daily", "weekly"] as const;
export type HabitCadence = (typeof HABIT_CADENCES)[number];

export interface Habit extends BaseRecord {
  areaId: Id | null;
  name: string;
  /** Why this habit exists — surfaced at check-in time to keep intent visible. */
  motivation: string;
  color: string;
  cadence: HabitCadence;
  /** For `daily`: which weekdays count (0=Sun..6=Sat). For `weekly`: scheduling is ignored. */
  weekdays: number[];
  /** For `weekly`: how many check-ins make the week a success. */
  timesPerWeek: number;
  /** Unit label for quantified habits ("pages", "km"). Empty = simple yes/no. */
  unit: string;
  /** Per-check-in goal for quantified habits. 0 = yes/no habit. */
  targetValue: number;
  archived: boolean;
  sortOrder: number;
}

export interface HabitEntry extends BaseRecord {
  habitId: Id;
  /** Local day key `YYYY-MM-DD`. Unique per habit — enforced on write, not by index. */
  dayKey: string;
  /** Yes/no habits store 1. Quantified habits store the measured amount. */
  value: number;
  note: string;
}

export const MOODS = [1, 2, 3, 4, 5] as const;
export type Mood = (typeof MOODS)[number];

export interface JournalEntry extends BaseRecord {
  /** Local day key `YYYY-MM-DD`. One entry per day. */
  dayKey: string;
  title: string;
  body: string;
  mood: Mood | null;
  energy: Mood | null;
  tags: string[];
  /** Career-facing prompts, kept as first-class fields so they stay queryable. */
  wins: string;
  blockers: string;
  tomorrow: string;
}

/**
 * Append-only audit trail. Answers "what actually happened, and when" without
 * re-deriving it from mutable rows that later edits would have rewritten.
 */
export interface ActivityEvent extends BaseRecord {
  at: number;
  dayKey: string;
  type: ActivityType;
  entity: string;
  entityId: Id | null;
  summary: string;
  meta: Record<string, string | number | boolean | null>;
}

export const ACTIVITY_TYPES = [
  "created",
  "updated",
  "deleted",
  "completed",
  "started",
  "abandoned",
  "checkin",
  "synced",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export type SyncMode = "local" | "supabase" | "rest";

export interface Settings {
  /** Fixed key — settings is a singleton row, not a synced collection. */
  id: "settings";
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  /** Focus runs completed before a long break is offered. */
  longBreakEvery: number;
  autoStartBreaks: boolean;
  autoStartFocus: boolean;
  /** Daily focus-session goal, used by the dashboard ring. */
  dailyGoalPomodoros: number;
  soundEnabled: boolean;
  soundVolume: number;
  notificationsEnabled: boolean;
  /** Hour (0-23) at which a new "day" starts, for night owls. */
  dayStartHour: number;
  theme: "dark" | "light" | "system";
  syncMode: SyncMode;
  supabaseUrl: string;
  supabaseAnonKey: string;
  restUrl: string;
  restToken: string;
  /** Watermark for incremental pull: max `updatedAt` seen from the remote. */
  lastPulledAt: number;
  updatedAt: number;
}

export const DEFAULT_SETTINGS: Settings = {
  id: "settings",
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  longBreakEvery: 4,
  autoStartBreaks: true,
  autoStartFocus: false,
  dailyGoalPomodoros: 8,
  soundEnabled: true,
  soundVolume: 0.5,
  notificationsEnabled: true,
  dayStartHour: 0,
  theme: "dark",
  syncMode: "local",
  supabaseUrl: "",
  supabaseAnonKey: "",
  restUrl: "",
  restToken: "",
  lastPulledAt: 0,
  updatedAt: 0,
};

/** Collections the sync engine moves. Settings is deliberately excluded — it holds device credentials. */
export const SYNCED_TABLES = [
  "areas",
  "projects",
  "tasks",
  "sessions",
  "habits",
  "habitEntries",
  "journalEntries",
  "activity",
] as const;
export type SyncedTable = (typeof SYNCED_TABLES)[number];

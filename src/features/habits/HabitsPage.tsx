import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Flame, Plus, Trash2 } from "lucide-react";
import clsx from "clsx";
import { db } from "../../lib/db";
import { areasRepo, habitEntriesRepo, habitsRepo } from "../../lib/repository";
import { habitStats, isEntrySatisfying, isHabitScheduled } from "../../lib/analytics";
import { dateFromDayKey, lastNDayKeys, todayKey } from "../../lib/time";
import { useSettings } from "../../store/settings-store";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, SectionTitle, Select } from "../../components/ui";
import { HABIT_CADENCES, type Habit, type HabitCadence, type HabitEntry } from "../../lib/types";

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const HABIT_COLORS = ["#3ecf8e", "#5aa9ff", "#ff6b5a", "#f2c14e", "#b98bff", "#ff8fc7"];
const GRID_DAYS = 91;

export function HabitsPage() {
  const settings = useSettings((s) => s.settings);
  const today = todayKey(settings.dayStartHour);
  const [creating, setCreating] = useState(false);

  const habits = useLiveQuery(
    async () => (await habitsRepo.all()).filter((h) => !h.archived).sort((a, b) => a.sortOrder - b.sortOrder),
    [],
    [],
  );
  const entries = useLiveQuery(
    async () => (await db.habitEntries.toArray()).filter((entry) => entry.deletedAt === null),
    [],
    [],
  );

  const entriesByHabit = useMemo(() => {
    const grouped = new Map<string, HabitEntry[]>();
    for (const entry of entries ?? []) {
      const bucket = grouped.get(entry.habitId);
      if (bucket) bucket.push(entry);
      else grouped.set(entry.habitId, [entry]);
    }
    return grouped;
  }, [entries]);

  const dayKeys = useMemo(() => lastNDayKeys(GRID_DAYS, today), [today]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <Card>
        <SectionTitle
          action={
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> New habit
            </Button>
          }
        >
          Today&apos;s check-in
        </SectionTitle>

        {(habits ?? []).length === 0 ? (
          <EmptyState
            title="No habits yet"
            body="Habits are the routine underneath the results — reading, exercise, deep work before noon. Track a few and the streaks do the arguing for you."
            action={
              <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                Add your first habit
              </Button>
            }
          />
        ) : (
          <ul className="space-y-2">
            {(habits ?? []).map((habit) => (
              <CheckInRow
                key={habit.id}
                habit={habit}
                today={today}
                entry={(entriesByHabit.get(habit.id) ?? []).find((entry) => entry.dayKey === today)}
                dayStartHour={settings.dayStartHour}
              />
            ))}
          </ul>
        )}
      </Card>

      {(habits ?? []).map((habit) => {
        const habitEntries = entriesByHabit.get(habit.id) ?? [];
        const stats = habitStats(habit, habitEntries, today);
        return (
          <Card key={habit.id}>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-2 font-semibold">
                  <span className="h-3 w-3 rounded-full" style={{ background: habit.color }} />
                  {habit.name}
                </h3>
                {habit.motivation && <p className="mt-1 text-sm text-[var(--muted)]">{habit.motivation}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={stats.currentStreak > 0 ? "accent" : "muted"}>
                  <Flame size={12} /> {stats.currentStreak} day streak
                </Badge>
                <Badge tone="muted">best {stats.bestStreak}</Badge>
                <Badge tone="info">{Math.round(stats.completionRate * 100)}% kept</Badge>
                {stats.weekProgress !== null && (
                  <Badge tone={stats.weekProgress >= habit.timesPerWeek ? "rest" : "warn"}>
                    {stats.weekProgress}/{habit.timesPerWeek} this week
                  </Badge>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  title="Archive habit"
                  onClick={() =>
                    void habitsRepo.remove(habit.id, {
                      summary: `Removed habit “${habit.name}”`,
                      dayStartHour: settings.dayStartHour,
                    })
                  }
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </div>
            <HabitGrid habit={habit} entries={habitEntries} dayKeys={dayKeys} today={today} />
          </Card>
        );
      })}

      <HabitCreator open={creating} onClose={() => setCreating(false)} count={(habits ?? []).length} />
    </div>
  );
}

async function toggleCheckIn(
  habit: Habit,
  dayKey: string,
  entry: HabitEntry | undefined,
  dayStartHour: number,
  value?: number,
): Promise<void> {
  const target = value ?? (habit.targetValue > 0 ? habit.targetValue : 1);
  if (entry) {
    // Toggling off deletes the row rather than writing a zero: a zero would read as
    // "measured none" in the history, which is a different fact from "didn't log".
    if (value === undefined && isEntrySatisfying(habit, entry)) {
      await habitsEntryRemove(entry.id, habit.name, dayStartHour);
      return;
    }
    await habitEntriesRepo.update(entry.id, { value: target });
    return;
  }
  await habitEntriesRepo.create(
    { habitId: habit.id, dayKey, value: target, note: "" },
    { summary: `Checked in “${habit.name}”`, dayStartHour },
  );
}

async function habitsEntryRemove(entryId: string, habitName: string, dayStartHour: number): Promise<void> {
  await habitEntriesRepo.remove(entryId, { summary: `Undid check-in for “${habitName}”`, dayStartHour });
}

function CheckInRow({
  habit,
  today,
  entry,
  dayStartHour,
}: {
  habit: Habit;
  today: string;
  entry: HabitEntry | undefined;
  dayStartHour: number;
}) {
  const satisfied = isEntrySatisfying(habit, entry);
  const scheduled = isHabitScheduled(habit, today);
  const quantified = habit.targetValue > 0;

  return (
    <li
      className={clsx(
        "flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2.5 transition",
        satisfied && "border-[color-mix(in_srgb,var(--rest)_50%,transparent)] bg-[color-mix(in_srgb,var(--rest)_10%,transparent)]",
        !scheduled && "opacity-55",
      )}
    >
      <button
        type="button"
        aria-pressed={satisfied}
        aria-label={`${satisfied ? "Undo" : "Complete"} ${habit.name}`}
        onClick={() => void toggleCheckIn(habit, today, entry, dayStartHour)}
        className={clsx(
          "grid h-7 w-7 shrink-0 place-items-center rounded-lg border-2 transition",
          satisfied ? "border-transparent text-white" : "hover:border-[var(--accent)]",
        )}
        style={satisfied ? { background: habit.color } : undefined}
      >
        {satisfied ? "✓" : ""}
      </button>

      <div className="min-w-0 flex-1">
        <span className="block truncate font-medium">{habit.name}</span>
        <span className="text-xs text-[var(--muted)]">
          {!scheduled
            ? "Not scheduled today"
            : quantified
              ? `Target ${habit.targetValue} ${habit.unit}`
              : habit.cadence === "weekly"
                ? `${habit.timesPerWeek}× per week`
                : "Daily"}
        </span>
      </div>

      {quantified && (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            className="w-24"
            value={entry?.value ?? 0}
            aria-label={`${habit.name} amount`}
            onChange={(event) =>
              void toggleCheckIn(habit, today, entry, dayStartHour, Number(event.target.value) || 0)
            }
          />
          <span className="text-xs text-[var(--muted)]">{habit.unit}</span>
        </div>
      )}
    </li>
  );
}

/**
 * Contribution-style grid, weeks as columns. Unscheduled days render faint rather than
 * empty so a Mon/Wed/Fri habit doesn't look like a wall of misses.
 */
function HabitGrid({
  habit,
  entries,
  dayKeys,
  today,
}: {
  habit: Habit;
  entries: HabitEntry[];
  dayKeys: string[];
  today: string;
}) {
  const byDay = useMemo(() => new Map(entries.map((entry) => [entry.dayKey, entry])), [entries]);

  // Pad the front so the first column starts on a Sunday and rows line up with weekdays.
  const leadingBlanks = dateFromDayKey(dayKeys[0]).getDay();
  const cells: (string | null)[] = [...Array.from<null>({ length: leadingBlanks }).fill(null), ...dayKeys];
  const columns: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) columns.push(cells.slice(i, i + 7));

  return (
    <div className="overflow-x-auto">
      <div className="flex gap-1">
        <div className="mr-1 flex flex-col gap-1 pt-0.5">
          {WEEKDAY_LABELS.map((label, index) => (
            <span key={index} className="h-3.5 text-[9px] leading-3.5 text-[var(--muted)]">
              {index % 2 === 1 ? label : ""}
            </span>
          ))}
        </div>
        {columns.map((column, columnIndex) => (
          <div key={columnIndex} className="flex flex-col gap-1">
            {Array.from({ length: 7 }, (_, rowIndex) => {
              const dayKey = column[rowIndex] ?? null;
              if (!dayKey) return <span key={rowIndex} className="h-3.5 w-3.5" />;
              const scheduled = isHabitScheduled(habit, dayKey);
              const satisfied = isEntrySatisfying(habit, byDay.get(dayKey));
              return (
                <span
                  key={rowIndex}
                  title={`${dayKey}${satisfied ? " · done" : scheduled ? " · missed" : " · not scheduled"}`}
                  className={clsx(
                    "h-3.5 w-3.5 rounded-[3px] border",
                    dayKey === today && "ring-1 ring-[var(--accent)]",
                  )}
                  style={{
                    background: satisfied ? habit.color : "var(--surface-2)",
                    opacity: satisfied ? 1 : scheduled ? 0.85 : 0.3,
                    borderColor: "transparent",
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function HabitCreator({ open, onClose, count }: { open: boolean; onClose: () => void; count: number }) {
  const [name, setName] = useState("");
  const [motivation, setMotivation] = useState("");
  const [cadence, setCadence] = useState<HabitCadence>("daily");
  const [weekdays, setWeekdays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [timesPerWeek, setTimesPerWeek] = useState(3);
  const [unit, setUnit] = useState("");
  const [targetValue, setTargetValue] = useState(0);
  const [areaId, setAreaId] = useState("");
  const areas = useLiveQuery(async () => (await areasRepo.all()).filter((a) => !a.archived), [], []);

  return (
    <Modal open={open} title="New habit" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Habit">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Read 20 pages" />
        </Field>
        <Field label="Why it matters" hint="Shown next to the habit — future you will want the reason.">
          <Input
            value={motivation}
            onChange={(event) => setMotivation(event.target.value)}
            placeholder="Compounding beats cramming"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Cadence">
            <Select value={cadence} onChange={(event) => setCadence(event.target.value as HabitCadence)}>
              {HABIT_CADENCES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Area">
            <Select value={areaId} onChange={(event) => setAreaId(event.target.value)}>
              <option value="">No area</option>
              {(areas ?? []).map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {cadence === "daily" ? (
          <Field label="Days" hint="Unselected days are skipped, not counted as misses.">
            <div className="flex gap-1.5">
              {WEEKDAY_LABELS.map((label, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() =>
                    setWeekdays((current) =>
                      current.includes(index) ? current.filter((d) => d !== index) : [...current, index],
                    )
                  }
                  className={clsx(
                    "h-9 w-9 rounded-lg border text-sm transition",
                    weekdays.includes(index) ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "hover:bg-[var(--surface-2)]",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
        ) : (
          <Field label="Times per week">
            <Input
              type="number"
              min={1}
              max={7}
              value={timesPerWeek}
              onChange={(event) => setTimesPerWeek(Math.min(7, Math.max(1, Number(event.target.value) || 1)))}
            />
          </Field>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Measure (optional)" hint="Leave blank for a yes/no habit.">
            <Input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="pages, km, minutes" />
          </Field>
          <Field label="Daily target">
            <Input
              type="number"
              min={0}
              value={targetValue}
              onChange={(event) => setTargetValue(Number(event.target.value) || 0)}
            />
          </Field>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={async () => {
              await habitsRepo.create({
                name: name.trim(),
                motivation: motivation.trim(),
                color: HABIT_COLORS[count % HABIT_COLORS.length],
                cadence,
                weekdays: cadence === "daily" ? weekdays : [],
                timesPerWeek,
                unit: unit.trim(),
                targetValue: unit.trim() ? targetValue : 0,
                areaId: areaId || null,
                archived: false,
                sortOrder: Date.now(),
              });
              setName("");
              setMotivation("");
              setUnit("");
              setTargetValue(0);
              onClose();
            }}
          >
            Create habit
          </Button>
        </div>
      </div>
    </Modal>
  );
}

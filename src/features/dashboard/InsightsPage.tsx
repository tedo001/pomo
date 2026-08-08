import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Flame } from "lucide-react";
import { db } from "../../lib/db";
import { areasRepo } from "../../lib/repository";
import {
  dayStatsFor,
  focusCompletionRate,
  focusMsByHour,
  focusMsByKey,
  focusStreak,
  totalFocusMs,
} from "../../lib/analytics";
import { formatDuration, lastNDayKeys, todayKey } from "../../lib/time";
import { useSettings } from "../../store/settings-store";
import { Badge, Button, Card, EmptyState, SectionTitle, Stat } from "../../components/ui";

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

export function InsightsPage() {
  const settings = useSettings((s) => s.settings);
  const today = todayKey(settings.dayStartHour);
  const [days, setDays] = useState<number>(30);

  const dayKeys = useMemo(() => lastNDayKeys(days, today), [days, today]);
  const from = dayKeys[0];

  const sessions = useLiveQuery(
    async () =>
      (await db.sessions.where("dayKey").between(from, today, true, true).toArray()).filter(
        (row) => row.deletedAt === null,
      ),
    [from, today],
    [],
  );
  const allSessions = useLiveQuery(
    async () => (await db.sessions.toArray()).filter((row) => row.deletedAt === null),
    [],
    [],
  );
  const areas = useLiveQuery(async () => await areasRepo.all(), [], []);

  const daily = useMemo(() => dayStatsFor(sessions ?? [], dayKeys), [sessions, dayKeys]);
  const streak = useMemo(() => focusStreak(allSessions ?? [], today), [allSessions, today]);

  const areaSlices = useMemo(() => {
    const totals = focusMsByKey(sessions ?? [], "areaId");
    return [...totals.entries()]
      .map(([areaId, ms]) => ({
        name: (areas ?? []).find((area) => area.id === areaId)?.name ?? "Unattributed",
        color: (areas ?? []).find((area) => area.id === areaId)?.color ?? "#8695ab",
        ms,
      }))
      .sort((a, b) => b.ms - a.ms);
  }, [sessions, areas]);

  const hourly = useMemo(() => {
    const hours = focusMsByHour(sessions ?? []);
    return hours.map((ms, hour) => ({ hour: `${String(hour).padStart(2, "0")}`, minutes: Math.round(ms / 60000) }));
  }, [sessions]);

  const focusMs = totalFocusMs(sessions ?? []);
  const completion = focusCompletionRate(sessions ?? []);
  const finished = (sessions ?? []).filter((s) => s.kind === "focus" && s.completed).length;
  const activeDays = daily.filter((day) => day.focusCount > 0).length;

  if ((allSessions ?? []).length === 0) {
    return (
      <div className="mx-auto w-full max-w-5xl">
        <EmptyState
          title="No history yet"
          body="Run your first focus session and this page fills in — daily focus time, which areas actually got your attention, when in the day you do your best work, and how often you finish what you start."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          {RANGES.map((range) => (
            <Button
              key={range.days}
              size="sm"
              variant={days === range.days ? "primary" : "ghost"}
              onClick={() => setDays(range.days)}
            >
              {range.label}
            </Button>
          ))}
        </div>
        <Badge tone={streak > 0 ? "accent" : "muted"}>
          <Flame size={12} /> {streak} day focus streak
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Focus time" value={formatDuration(focusMs)} sub={`last ${days} days`} />
        <Stat label="Sessions" value={String(finished)} sub={`${Math.round(completion * 100)}% finished`} />
        <Stat
          label="Daily average"
          value={formatDuration(activeDays === 0 ? 0 : focusMs / activeDays)}
          sub={`across ${activeDays} active days`}
        />
        <Stat
          label="Consistency"
          value={`${Math.round((activeDays / days) * 100)}%`}
          sub={`${activeDays} of ${days} days`}
        />
      </div>

      <Card>
        <SectionTitle>Focus per day</SectionTitle>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={daily.map((day) => ({ ...day, minutes: Math.round(day.focusMs / 60000) }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="dayKey"
                stroke="var(--muted)"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                // A 90-day range would overlap every label; thin them out instead.
                interval={Math.max(0, Math.floor(daily.length / 10) - 1)}
                tickFormatter={(value: string) => value.slice(5)}
              />
              <YAxis stroke="var(--muted)" fontSize={11} tickLine={false} axisLine={false} width={34} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value) => [`${Number(value)} min`, "Focus"]}
              />
              <Bar dataKey="minutes" fill="var(--accent)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <SectionTitle>Where the time went</SectionTitle>
          {areaSlices.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No focus time in this range.</p>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={areaSlices}
                    dataKey="ms"
                    nameKey="name"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={2}
                    stroke="none"
                  >
                    {areaSlices.map((slice) => (
                      <Cell key={slice.name} fill={slice.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value, name) => [formatDuration(Number(value)), String(name)]}
                  />
                  <Legend
                    verticalAlign="bottom"
                    height={36}
                    formatter={(value) => <span style={{ color: "var(--muted)", fontSize: 12 }}>{String(value)}</span>}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle>When you focus best</SectionTitle>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourly}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="hour" stroke="var(--muted)" fontSize={11} tickLine={false} axisLine={false} interval={2} />
                <YAxis stroke="var(--muted)" fontSize={11} tickLine={false} axisLine={false} width={34} />
                <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value) => [`${Number(value)} min`, "Focus"]} />
                <Bar dataKey="minutes" fill="var(--info)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-xs text-[var(--muted)]">
            Hour of day, summed across the range. Protect the peaks; schedule shallow work in the troughs.
          </p>
        </Card>
      </div>

      <Card>
        <SectionTitle>Weekly targets by area</SectionTitle>
        {(areas ?? []).filter((area) => area.weeklyTargetMinutes > 0).length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            Set a weekly focus target on an area to track it here — it turns a vague intention into a number you either
            hit or you don&apos;t.
          </p>
        ) : (
          <ul className="space-y-3">
            {(areas ?? [])
              .filter((area) => area.weeklyTargetMinutes > 0)
              .map((area) => {
                const last7 = lastNDayKeys(7, today);
                const ms = totalFocusMs(
                  (sessions ?? []).filter((s) => s.areaId === area.id && last7.includes(s.dayKey)),
                );
                const pct = Math.min(100, (ms / 60000 / area.weeklyTargetMinutes) * 100);
                return (
                  <li key={area.id}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: area.color }} />
                        {area.name}
                      </span>
                      <span className="tabular text-[var(--muted)]">
                        {formatDuration(ms)} / {formatDuration(area.weeklyTargetMinutes * 60000)}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-[var(--surface-2)]">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: area.color }} />
                    </div>
                  </li>
                );
              })}
          </ul>
        )}
      </Card>
    </div>
  );
}

const TOOLTIP_STYLE = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  fontSize: 12,
  color: "var(--text)",
} as const;

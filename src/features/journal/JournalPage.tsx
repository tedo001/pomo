import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronLeft, ChevronRight, Save } from "lucide-react";
import clsx from "clsx";
import { db } from "../../lib/db";
import { journalRepo } from "../../lib/repository";
import { formatDayLabel, formatDuration, shiftDayKey, todayKey } from "../../lib/time";
import { dayStatsFor } from "../../lib/analytics";
import { useSettings } from "../../store/settings-store";
import { Badge, Button, Card, Field, Input, SectionTitle, Textarea } from "../../components/ui";
import { MOODS, type JournalEntry, type Mood } from "../../lib/types";

const MOOD_FACES = ["😞", "🙁", "😐", "🙂", "😄"];

type Draft = Pick<JournalEntry, "title" | "body" | "mood" | "energy" | "tags" | "wins" | "blockers" | "tomorrow">;

const EMPTY_DRAFT: Draft = {
  title: "",
  body: "",
  mood: null,
  energy: null,
  tags: [],
  wins: "",
  blockers: "",
  tomorrow: "",
};

export function JournalPage() {
  const settings = useSettings((s) => s.settings);
  const today = todayKey(settings.dayStartHour);
  const [dayKey, setDayKey] = useState(today);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const entry = useLiveQuery(
    async () => (await db.journalEntries.where("dayKey").equals(dayKey).toArray()).find((row) => row.deletedAt === null),
    [dayKey],
  );

  const sessions = useLiveQuery(
    async () => (await db.sessions.where("dayKey").equals(dayKey).toArray()).filter((row) => row.deletedAt === null),
    [dayKey],
    [],
  );

  const activity = useLiveQuery(
    async () =>
      (await db.activity.where("dayKey").equals(dayKey).toArray())
        .filter((row) => row.deletedAt === null)
        .sort((a, b) => b.at - a.at),
    [dayKey],
    [],
  );

  const stats = useMemo(() => dayStatsFor(sessions ?? [], [dayKey])[0], [sessions, dayKey]);

  // Reload the draft whenever the day changes, or when the stored entry first arrives.
  // Keyed on `entry?.id` rather than the whole row so a sync-driven update doesn't
  // stomp characters the user is mid-way through typing.
  useEffect(() => {
    setDraft(entry ? pickDraft(entry) : EMPTY_DRAFT);
    setSavedAt(null);
  }, [dayKey, entry?.id]);

  async function save() {
    if (entry) {
      await journalRepo.update(entry.id, draft, {
        summary: `Updated journal for ${dayKey}`,
        dayStartHour: settings.dayStartHour,
      });
    } else {
      await journalRepo.create({ ...draft, dayKey }, {
        summary: `Wrote journal for ${dayKey}`,
        dayStartHour: settings.dayStartHour,
      });
    }
    setSavedAt(Date.now());
  }

  const recentEntries = useLiveQuery(
    async () =>
      (await db.journalEntries.toArray())
        .filter((row) => row.deletedAt === null)
        .sort((a, b) => b.dayKey.localeCompare(a.dayKey))
        .slice(0, 14),
    [],
    [],
  );

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-6">
        <Card>
          <div className="mb-5 flex items-center justify-between gap-3">
            <Button variant="ghost" size="sm" onClick={() => setDayKey(shiftDayKey(dayKey, -1))} aria-label="Previous day">
              <ChevronLeft size={16} />
            </Button>
            <div className="text-center">
              <h2 className="text-lg font-semibold">{formatDayLabel(dayKey, today)}</h2>
              <p className="text-xs text-[var(--muted)]">{dayKey}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDayKey(shiftDayKey(dayKey, 1))}
              disabled={dayKey >= today}
              aria-label="Next day"
            >
              <ChevronRight size={16} />
            </Button>
          </div>

          <div className="space-y-4">
            <Field label="Headline">
              <Input
                value={draft.title}
                placeholder="One line that sums up the day"
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <MoodPicker
                label="Mood"
                value={draft.mood}
                onChange={(mood) => setDraft({ ...draft, mood })}
              />
              <MoodPicker
                label="Energy"
                value={draft.energy}
                onChange={(energy) => setDraft({ ...draft, energy })}
              />
            </div>

            <Field label="What happened">
              <Textarea
                rows={7}
                value={draft.body}
                placeholder="Free-write. What you did, what you noticed, what you're chewing on."
                onChange={(event) => setDraft({ ...draft, body: event.target.value })}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Wins">
                <Textarea
                  rows={3}
                  value={draft.wins}
                  placeholder="Shipped, learned, unblocked…"
                  onChange={(event) => setDraft({ ...draft, wins: event.target.value })}
                />
              </Field>
              <Field label="Blockers">
                <Textarea
                  rows={3}
                  value={draft.blockers}
                  placeholder="What got in the way"
                  onChange={(event) => setDraft({ ...draft, blockers: event.target.value })}
                />
              </Field>
              <Field label="Tomorrow">
                <Textarea
                  rows={3}
                  value={draft.tomorrow}
                  placeholder="The first thing you'll pick up"
                  onChange={(event) => setDraft({ ...draft, tomorrow: event.target.value })}
                />
              </Field>
            </div>

            <Field label="Tags" hint="Comma separated — useful for finding themes months later.">
              <Input
                value={draft.tags.join(", ")}
                placeholder="interview-prep, deep-work, health"
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    tags: event.target.value
                      .split(",")
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Field>

            <div className="flex items-center justify-end gap-3">
              {savedAt && <span className="text-xs text-[var(--muted)]">Saved</span>}
              <Button variant="primary" onClick={() => void save()}>
                <Save size={16} /> Save entry
              </Button>
            </div>
          </div>
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <SectionTitle>That day, measured</SectionTitle>
          <dl className="space-y-2 text-sm">
            <Row label="Focus time" value={formatDuration(stats?.focusMs ?? 0)} />
            <Row label="Sessions finished" value={String(stats?.focusCount ?? 0)} />
            <Row label="Stopped early" value={String(stats?.abandoned ?? 0)} />
            <Row label="Distractions" value={String(stats?.interruptions ?? 0)} />
          </dl>
        </Card>

        <Card>
          <SectionTitle>Trail</SectionTitle>
          {(activity ?? []).length === 0 ? (
            <p className="text-sm text-[var(--muted)]">Nothing recorded for this day.</p>
          ) : (
            <ul className="space-y-2.5 text-sm">
              {(activity ?? []).slice(0, 30).map((event) => (
                <li key={event.id} className="flex gap-2">
                  <span className="tabular shrink-0 text-xs text-[var(--muted)]">
                    {new Date(event.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="min-w-0">{event.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <SectionTitle>Recent entries</SectionTitle>
          <ul className="space-y-1.5 text-sm">
            {(recentEntries ?? []).map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => setDayKey(row.dayKey)}
                  className={clsx(
                    "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-[var(--surface-2)]",
                    row.dayKey === dayKey && "bg-[var(--surface-2)]",
                  )}
                >
                  <span className="truncate">{row.title || formatDayLabel(row.dayKey, today)}</span>
                  <span className="shrink-0">{row.mood ? MOOD_FACES[row.mood - 1] : ""}</span>
                </button>
              </li>
            ))}
            {(recentEntries ?? []).length === 0 && <li className="text-[var(--muted)]">No entries yet.</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function pickDraft(entry: JournalEntry): Draft {
  return {
    title: entry.title,
    body: entry.body,
    mood: entry.mood,
    energy: entry.energy,
    tags: entry.tags,
    wins: entry.wins,
    blockers: entry.blockers,
    tomorrow: entry.tomorrow,
  };
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-[var(--muted)]">{label}</dt>
      <dd className="tabular font-medium">{value}</dd>
    </div>
  );
}

function MoodPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Mood | null;
  onChange: (value: Mood | null) => void;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-[var(--muted)]">{label}</span>
      <div className="flex gap-1.5">
        {MOODS.map((mood, index) => (
          <button
            key={mood}
            type="button"
            aria-pressed={value === mood}
            aria-label={`${label} ${mood} of 5`}
            // Clicking the active face clears it — an unset mood is real data, not a
            // reason to force a choice.
            onClick={() => onChange(value === mood ? null : mood)}
            className={clsx(
              "h-10 flex-1 rounded-lg border text-lg transition",
              value === mood ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "hover:bg-[var(--surface-2)]",
            )}
          >
            {MOOD_FACES[index]}
          </button>
        ))}
      </div>
      {value !== null && <Badge tone="muted">{value}/5</Badge>}
    </div>
  );
}

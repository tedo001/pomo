import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, Circle, Play, Plus, Trash2 } from "lucide-react";
import clsx from "clsx";
import { areasRepo, projectsRepo, tasksRepo } from "../../lib/repository";
import { formatDayLabel } from "../../lib/time";
import { useSettings } from "../../store/settings-store";
import { useTimer } from "../../store/timer-store";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, SectionTitle, Select, Textarea } from "../../components/ui";
import { PRIORITIES, PROJECT_STATUSES, type Area, type Priority, type Project, type Task } from "../../lib/types";

const AREA_COLORS = ["#ff6b5a", "#3ecf8e", "#5aa9ff", "#f2c14e", "#b98bff", "#ff8fc7"];

export function TasksPage({ onStartFocus }: { onStartFocus: () => void }) {
  const settings = useSettings((s) => s.settings);
  const [areaFilter, setAreaFilter] = useState<string>("all");
  const [showDone, setShowDone] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftProject, setDraftProject] = useState("");
  const [editing, setEditing] = useState<Task | null>(null);
  const [areaModal, setAreaModal] = useState(false);
  const [projectModal, setProjectModal] = useState(false);

  const areas = useLiveQuery(async () => (await areasRepo.all()).filter((a) => !a.archived).sort(bySortOrder), [], []);
  const projects = useLiveQuery(async () => (await projectsRepo.all()).sort(bySortOrder), [], []);
  const tasks = useLiveQuery(async () => (await tasksRepo.all()).sort(bySortOrder), [], []);

  const visible = useMemo(() => {
    const rows = (tasks ?? []).filter((task) => {
      if (areaFilter !== "all" && task.areaId !== areaFilter) return false;
      if (!showDone && (task.status === "done" || task.status === "dropped")) return false;
      return true;
    });
    // Open work first, then priority, then manual order — so the list reads as a queue.
    const rank: Record<Priority, number> = { high: 0, normal: 1, low: 2 };
    return rows.sort((a, b) => {
      const aDone = a.status === "done" || a.status === "dropped";
      const bDone = b.status === "done" || b.status === "dropped";
      if (aDone !== bDone) return aDone ? 1 : -1;
      if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];
      return a.sortOrder - b.sortOrder;
    });
  }, [tasks, areaFilter, showDone]);

  async function addTask() {
    const title = draftTitle.trim();
    if (!title) return;
    const project = (projects ?? []).find((p) => p.id === draftProject);
    await tasksRepo.create(
      {
        title,
        notes: "",
        projectId: project?.id ?? null,
        // Denormalised from the project so a session can be attributed to an area
        // without a second lookup on the hot path when the timer starts.
        areaId: project?.areaId ?? (areaFilter === "all" ? null : areaFilter),
        status: "todo",
        priority: "normal",
        estimatePomodoros: 0,
        donePomodoros: 0,
        dueAt: null,
        completedAt: null,
        sortOrder: Date.now(),
      },
      { summary: `Added task “${title}”`, dayStartHour: settings.dayStartHour },
    );
    setDraftTitle("");
  }

  async function toggleTask(task: Task) {
    const done = task.status === "done";
    await tasksRepo.update(
      task.id,
      { status: done ? "todo" : "done", completedAt: done ? null : Date.now() },
      done ? undefined : { summary: `Completed “${task.title}”`, dayStartHour: settings.dayStartHour },
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <Card>
        <SectionTitle
          action={
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setAreaModal(true)}>
                <Plus size={14} /> Area
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setProjectModal(true)}>
                <Plus size={14} /> Project
              </Button>
            </div>
          }
        >
          Focus areas
        </SectionTitle>
        <div className="flex flex-wrap gap-2">
          <FilterChip active={areaFilter === "all"} onClick={() => setAreaFilter("all")} label="Everything" />
          {(areas ?? []).map((area) => (
            <FilterChip
              key={area.id}
              active={areaFilter === area.id}
              onClick={() => setAreaFilter(area.id)}
              label={area.name}
              color={area.color}
            />
          ))}
          {(areas ?? []).length === 0 && (
            <p className="text-sm text-[var(--muted)]">
              Areas are the buckets your career and life split into — “Engineering”, “Health”, “Side project”. Add one to
              start attributing focus time.
            </p>
          )}
        </div>
      </Card>

      <Card>
        <SectionTitle
          action={
            <Button size="sm" variant="ghost" onClick={() => setShowDone((value) => !value)}>
              {showDone ? "Hide finished" : "Show finished"}
            </Button>
          }
        >
          Tasks
        </SectionTitle>

        <div className="mb-4 flex flex-col gap-2 sm:flex-row">
          <Input
            value={draftTitle}
            placeholder="What needs doing?"
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void addTask();
            }}
          />
          <Select
            className="sm:w-56"
            value={draftProject}
            onChange={(event) => setDraftProject(event.target.value)}
            aria-label="Project"
          >
            <option value="">No project</option>
            {(projects ?? [])
              .filter((project) => project.status === "active")
              .map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
          </Select>
          <Button variant="primary" onClick={() => void addTask()} disabled={!draftTitle.trim()}>
            <Plus size={16} /> Add
          </Button>
        </div>

        {visible.length === 0 ? (
          <EmptyState
            title="Nothing queued"
            body="Add the next concrete thing you'll work on. Tasks give your pomodoros a subject, which is what makes the history worth reading later."
          />
        ) : (
          <ul className="divide-y">
            {visible.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                project={(projects ?? []).find((p) => p.id === task.projectId)}
                area={(areas ?? []).find((a) => a.id === task.areaId)}
                onToggle={() => void toggleTask(task)}
                onEdit={() => setEditing(task)}
                onDelete={() =>
                  void tasksRepo.remove(task.id, {
                    summary: `Deleted task “${task.title}”`,
                    dayStartHour: settings.dayStartHour,
                  })
                }
                onFocus={() => {
                  useTimer.getState().setTask(task.id);
                  onStartFocus();
                }}
              />
            ))}
          </ul>
        )}
      </Card>

      {(projects ?? []).length > 0 && (
        <Card>
          <SectionTitle>Projects</SectionTitle>
          <ul className="grid gap-3 sm:grid-cols-2">
            {(projects ?? []).map((project) => {
              const area = (areas ?? []).find((a) => a.id === project.areaId);
              const open = (tasks ?? []).filter((t) => t.projectId === project.id && t.status !== "done").length;
              return (
                <li key={project.id} className="rounded-xl border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{project.name}</p>
                      <p className="mt-0.5 text-xs text-[var(--muted)]">
                        {area?.name ?? "No area"} · {open} open
                        {project.dueAt ? ` · due ${formatDayLabel(new Date(project.dueAt).toISOString().slice(0, 10))}` : ""}
                      </p>
                    </div>
                    <Select
                      className="w-28 shrink-0"
                      value={project.status}
                      onChange={(event) =>
                        void projectsRepo.update(project.id, { status: event.target.value as Project["status"] })
                      }
                      aria-label={`Status for ${project.name}`}
                    >
                      {PROJECT_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </Select>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <TaskEditor
        task={editing}
        projects={projects ?? []}
        areas={areas ?? []}
        onClose={() => setEditing(null)}
        dayStartHour={settings.dayStartHour}
      />
      <AreaEditor open={areaModal} onClose={() => setAreaModal(false)} count={(areas ?? []).length} />
      <ProjectEditor open={projectModal} onClose={() => setProjectModal(false)} areas={areas ?? []} />
    </div>
  );
}

function bySortOrder(a: { sortOrder: number }, b: { sortOrder: number }): number {
  return a.sortOrder - b.sortOrder;
}

function FilterChip({
  active,
  label,
  color,
  onClick,
}: {
  active: boolean;
  label: string;
  color?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition",
        active ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "hover:bg-[var(--surface-2)]",
      )}
    >
      {color && <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />}
      {label}
    </button>
  );
}

function TaskRow({
  task,
  project,
  area,
  onToggle,
  onEdit,
  onDelete,
  onFocus,
}: {
  task: Task;
  project?: Project;
  area?: Area;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onFocus: () => void;
}) {
  const done = task.status === "done" || task.status === "dropped";
  return (
    <li className="group flex items-center gap-3 py-2.5">
      <button
        type="button"
        onClick={onToggle}
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        className="shrink-0 text-[var(--muted)] transition hover:text-[var(--accent)]"
      >
        {done ? <Check size={18} className="text-[var(--rest)]" /> : <Circle size={18} />}
      </button>

      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
        <span className={clsx("block truncate", done && "text-[var(--muted)] line-through")}>{task.title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-[var(--muted)]">
          {area && (
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ background: area.color }} />
              {area.name}
            </span>
          )}
          {project && <span>· {project.name}</span>}
          {task.estimatePomodoros > 0 && (
            <span>
              · {task.donePomodoros}/{task.estimatePomodoros} 🍅
            </span>
          )}
          {task.estimatePomodoros === 0 && task.donePomodoros > 0 && <span>· {task.donePomodoros} 🍅</span>}
        </span>
      </button>

      {task.priority !== "normal" && (
        <Badge tone={task.priority === "high" ? "accent" : "muted"}>{task.priority}</Badge>
      )}

      <div className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
        {!done && (
          <Button size="sm" variant="ghost" onClick={onFocus} title="Focus on this task">
            <Play size={14} />
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDelete} title="Delete task">
          <Trash2 size={14} />
        </Button>
      </div>
    </li>
  );
}

function TaskEditor({
  task,
  projects,
  areas,
  onClose,
  dayStartHour,
}: {
  task: Task | null;
  projects: Project[];
  areas: Area[];
  onClose: () => void;
  dayStartHour: number;
}) {
  const [form, setForm] = useState<Task | null>(task);
  // Re-seed when a different row is opened; the modal is reused across tasks.
  if (task?.id !== form?.id) setForm(task);
  if (!form) return null;

  return (
    <Modal open={task !== null} title="Edit task" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Title">
          <Input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Project">
            <Select
              value={form.projectId ?? ""}
              onChange={(event) => {
                const project = projects.find((p) => p.id === event.target.value);
                setForm({ ...form, projectId: project?.id ?? null, areaId: project?.areaId ?? form.areaId });
              }}
            >
              <option value="">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Area">
            <Select
              value={form.areaId ?? ""}
              onChange={(event) => setForm({ ...form, areaId: event.target.value || null })}
            >
              <option value="">No area</option>
              {areas.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select
              value={form.priority}
              onChange={(event) => setForm({ ...form, priority: event.target.value as Priority })}
            >
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {priority}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Estimated pomodoros" hint="0 means unestimated">
            <Input
              type="number"
              min={0}
              value={form.estimatePomodoros}
              onChange={(event) => setForm({ ...form, estimatePomodoros: Number(event.target.value) || 0 })}
            />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea rows={4} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              await tasksRepo.update(
                form.id,
                {
                  title: form.title.trim() || form.title,
                  notes: form.notes,
                  projectId: form.projectId,
                  areaId: form.areaId,
                  priority: form.priority,
                  estimatePomodoros: form.estimatePomodoros,
                },
                { summary: `Updated task “${form.title}”`, dayStartHour },
              );
              onClose();
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AreaEditor({ open, onClose, count }: { open: boolean; onClose: () => void; count: number }) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState(0);
  const color = AREA_COLORS[count % AREA_COLORS.length];

  return (
    <Modal open={open} title="New area" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name" hint="A durable part of your life or career, not a one-off project.">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Engineering craft" />
        </Field>
        <Field label="Weekly focus target (minutes)" hint="0 to leave untracked.">
          <Input type="number" min={0} value={target} onChange={(event) => setTarget(Number(event.target.value) || 0)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={async () => {
              await areasRepo.create({
                name: name.trim(),
                color,
                weeklyTargetMinutes: target,
                archived: false,
                sortOrder: Date.now(),
              });
              setName("");
              setTarget(0);
              onClose();
            }}
          >
            Create
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ProjectEditor({ open, onClose, areas }: { open: boolean; onClose: () => void; areas: Area[] }) {
  const [name, setName] = useState("");
  const [areaId, setAreaId] = useState("");
  const [due, setDue] = useState("");

  return (
    <Modal open={open} title="New project" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Ship v2 of the API" />
        </Field>
        <Field label="Area">
          <Select value={areaId} onChange={(event) => setAreaId(event.target.value)}>
            <option value="">No area</option>
            {areas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Target date" hint="Optional — useful for career milestones.">
          <Input type="date" value={due} onChange={(event) => setDue(event.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={async () => {
              await projectsRepo.create({
                name: name.trim(),
                areaId: areaId || null,
                notes: "",
                status: "active",
                dueAt: due ? new Date(`${due}T12:00:00`).getTime() : null,
                sortOrder: Date.now(),
              });
              setName("");
              setAreaId("");
              setDue("");
              onClose();
            }}
          >
            Create
          </Button>
        </div>
      </div>
    </Modal>
  );
}

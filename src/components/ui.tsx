import clsx from "clsx";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

/** Shared primitives. Small on purpose — enough to keep the feature screens declarative. */

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section
      className={clsx(
        "rounded-2xl border bg-[var(--surface)] shadow-[0_1px_2px_rgba(0,0,0,0.18)]",
        padded && "p-5",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">{children}</h2>
      {action}
    </div>
  );
}

type ButtonVariant = "primary" | "ghost" | "outline" | "danger" | "subtle";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-[var(--accent)] text-white hover:brightness-110",
  outline: "border bg-transparent hover:bg-[var(--surface-2)]",
  ghost: "bg-transparent hover:bg-[var(--surface-2)]",
  subtle: "bg-[var(--surface-2)] hover:brightness-125",
  danger: "bg-transparent text-[var(--accent)] border border-[var(--accent)] hover:bg-[var(--accent-soft)]",
};

export function Button({
  variant = "subtle",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" | "lg" }) {
  return (
    <button
      type="button"
      {...props}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
        "disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" && "px-3 py-1.5 text-sm",
        size === "md" && "px-4 py-2 text-sm",
        size === "lg" && "px-6 py-3 text-base",
        BUTTON_STYLES[variant],
        className,
      )}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={clsx(
        "w-full rounded-xl border bg-[var(--surface-2)] px-3 py-2 text-sm placeholder:text-[var(--muted)]",
        "focus:outline-2 focus:outline-offset-0 focus:outline-[var(--ring)]",
        className,
      )}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={clsx(
        "w-full resize-y rounded-xl border bg-[var(--surface-2)] px-3 py-2 text-sm placeholder:text-[var(--muted)]",
        "focus:outline-2 focus:outline-offset-0 focus:outline-[var(--ring)]",
        className,
      )}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={clsx(
        "w-full rounded-xl border bg-[var(--surface-2)] px-3 py-2 text-sm",
        "focus:outline-2 focus:outline-offset-0 focus:outline-[var(--ring)]",
        className,
      )}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-[var(--muted)]">{label}</span>
      {children}
      {hint && <span className="block text-xs text-[var(--muted)]">{hint}</span>}
    </label>
  );
}

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "accent" | "rest" | "info" | "warn" }) {
  const toneClass = {
    muted: "bg-[var(--surface-2)] text-[var(--muted)]",
    accent: "bg-[var(--accent-soft)] text-[var(--accent)]",
    rest: "bg-[color-mix(in_srgb,var(--rest)_18%,transparent)] text-[var(--rest)]",
    info: "bg-[color-mix(in_srgb,var(--info)_18%,transparent)] text-[var(--info)]",
    warn: "bg-[color-mix(in_srgb,var(--warn)_20%,transparent)] text-[var(--warn)]",
  }[tone];
  return (
    <span className={clsx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", toneClass)}>
      {children}
    </span>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-2xl border bg-[var(--surface)] p-4">
      <div className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">{label}</div>
      <div className="tabular mt-1 text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-[var(--muted)]">{sub}</div>}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-[var(--muted)]">{body}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border bg-[var(--surface)] p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

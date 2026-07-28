import Link from "next/link";
import type { ReactNode } from "react";

/** Shared primitives. Modern, clean, dense. Stable API across all screens. */

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="text-muted mt-1 text-sm">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`bg-surface border border-line rounded-[var(--radius)] shadow-[var(--shadow-sm)] ${className}`}
    >
      {children}
    </div>
  );
}

export function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mb-7">
      {title && (
        <h2 className="text-[11px] font-semibold text-faint uppercase tracking-[0.08em] mb-2.5">
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

type Variant = "primary" | "default" | "danger" | "ghost";
const variantClass: Record<Variant, string> = {
  primary:
    "bg-[var(--color-brand)] text-white border-transparent shadow-[var(--shadow-sm)] hover:bg-[var(--color-brand-strong)]",
  default: "bg-surface text-ink border-line hover:bg-[var(--color-surface-2)] hover:border-line-strong",
  danger: "bg-[var(--color-danger)] text-white border-transparent hover:brightness-95",
  ghost: "bg-transparent text-[var(--color-brand)] border-transparent hover:bg-[var(--color-brand-soft)]",
};

const baseBtn =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

export function Button({
  children,
  variant = "default",
  type = "button",
  disabled,
  name,
  value,
  className = "",
}: {
  children: ReactNode;
  variant?: Variant;
  type?: "button" | "submit";
  disabled?: boolean;
  name?: string;
  value?: string;
  className?: string;
}) {
  return (
    <button
      type={type}
      name={name}
      value={value}
      disabled={disabled}
      className={`${baseBtn} ${variantClass[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function LinkButton({
  href,
  children,
  variant = "default",
}: {
  href: string;
  children: ReactNode;
  variant?: Variant;
}) {
  return (
    <Link href={href} className={`${baseBtn} ${variantClass[variant]}`}>
      {children}
    </Link>
  );
}

type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "info";
const toneClass: Record<BadgeTone, string> = {
  neutral: "bg-[var(--color-surface-2)] text-muted ring-1 ring-inset ring-line",
  ok: "bg-[var(--color-ok-soft)] text-[var(--color-ok)]",
  warn: "bg-[var(--color-warn-soft)] text-[var(--color-warn)]",
  danger: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
  info: "bg-[var(--color-info-soft)] text-[var(--color-info)]",
};

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${toneClass[tone]}`}
    >
      {children}
    </span>
  );
}

export function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-x-auto border border-line rounded-[var(--radius)] bg-surface shadow-[var(--shadow-sm)]">
      <table className="w-full text-sm border-collapse">
        <thead className="bg-[var(--color-surface-2)] text-muted text-left border-b border-line">
          {head}
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return (
    <th className={`px-3.5 py-2.5 font-semibold text-xs uppercase tracking-wide ${className}`}>
      {children}
    </th>
  );
}

export function Td({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <td className={`px-3.5 py-2.5 align-middle ${className}`}>{children}</td>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted text-sm py-12 text-center border border-dashed border-line rounded-[var(--radius)] bg-surface">
      {children}
    </div>
  );
}

export function money(n: number | string | null | undefined): string {
  const v = typeof n === "string" ? parseFloat(n) : n ?? 0;
  return "₹" + (v ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-[var(--color-danger-soft)] bg-[var(--color-danger-soft)] text-[var(--color-danger)] px-3.5 py-2.5 text-sm">
      {message}
    </div>
  );
}

export function FormOk({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-[var(--color-ok-soft)] bg-[var(--color-ok-soft)] text-[var(--color-ok)] px-3.5 py-2.5 text-sm">
      {message}
    </div>
  );
}

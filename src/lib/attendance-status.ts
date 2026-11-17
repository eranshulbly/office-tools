import type { DayStatus } from "@/lib/types";

/**
 * How a stored attendance status should read to a human.
 *
 * One value carries two very different meanings depending on when you look at
 * it. `unresolved` is "one punch, no matching second one":
 *
 *   - on a day that is still running, that is simply somebody who is at work
 *     and has not left yet — completely normal;
 *   - on a finished day, it is a real problem, it needs an adjustment, and it
 *     blocks the payroll run for that period.
 *
 * Rendering both as a red "Unresolved" made an ordinary morning look broken:
 * every person who had clocked in showed as an exception.
 *
 * The STORED value stays `unresolved` in both cases, deliberately. It is what
 * the payroll guard and the exception lists key off, and a day in progress
 * turns into a genuine exception by itself the moment the day ends without a
 * second punch — no migration, no background job, and no way for a day to slip
 * past the guard because it was written under a friendlier name.
 */

export const WAREHOUSE_TZ = "Asia/Kolkata";

/**
 * Asia/Kolkata is a fixed +05:30 and has never observed DST, so a constant is
 * exact here — no need to ask Intl for the offset at a particular instant.
 */
const WAREHOUSE_OFFSET_MINUTES = 330;

/**
 * A wall-clock time in the warehouse, as the UTC "YYYY-MM-DD HH:MM:SS" the
 * DATETIME columns hold. Used when an admin types "09:00" against a day.
 */
export function warehouseTimeToUtcSql(day: string, hhmm: string): string {
  const t = Date.parse(day + "T" + hhmm + ":00Z") - WAREHOUSE_OFFSET_MINUTES * 60_000;
  return new Date(t).toISOString().slice(0, 19).replace("T", " ");
}

/** The inverse: a stored instant as the "HH:MM" that prefills a time input. */
export function utcToWarehouseTime(ts: string | null): string {
  if (!ts) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: WAREHOUSE_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ts));
}

type Tone = "neutral" | "ok" | "warn" | "danger" | "info";

/**
 * Today as the warehouse reckons it.
 *
 * Not `new Date().toISOString().slice(0, 10)` — that is the UTC date, which
 * between midnight and 05:30 IST is still yesterday, exactly when a night
 * shift's punches are being written.
 */
export function warehouseToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: WAREHOUSE_TZ }).format(new Date());
}

const BASE: Record<DayStatus, { label: string; tone: Tone }> = {
  full_day: { label: "Present", tone: "ok" },
  absent: { label: "Absent", tone: "warn" },
  unresolved: { label: "Unresolved", tone: "danger" },
  not_working_day: { label: "Not working", tone: "neutral" },
  late_review: { label: "Late — review", tone: "danger" },
  half_day: { label: "Half day (legacy)", tone: "neutral" }, // never produced now
};

const PUNCHED_IN = { label: "Punched in", tone: "info" as Tone };

/** True when this row is someone still at work, not a day needing attention. */
export function isPunchedIn(status: string, day: string, today = warehouseToday()): boolean {
  return status === "unresolved" && day >= today;
}

export function statusView(
  status: string,
  day: string,
  today = warehouseToday()
): { label: string; tone: Tone } {
  if (isPunchedIn(status, day, today)) return PUNCHED_IN;
  return BASE[status as DayStatus] ?? { label: status, tone: "neutral" };
}

/** Same thing as a CSS colour, for the places that style text rather than a badge. */
const TONE_COLOR: Record<Tone, string> = {
  neutral: "var(--color-faint)",
  ok: "var(--color-ok)",
  warn: "var(--color-warn)",
  danger: "var(--color-danger)",
  info: "var(--color-brand)",
};

export function statusColor(status: string, day: string, today = warehouseToday()): string {
  return TONE_COLOR[statusView(status, day, today).tone];
}

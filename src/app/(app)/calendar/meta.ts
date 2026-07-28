import type { CalendarDayType } from "@/lib/types";

/**
 * Presentation for each calendar day type. Plain module (no "use client") so it
 * can be imported by both the server page and the client DayCell without turning
 * into a client reference.
 */
export const DAY_TYPE_META: Record<
  CalendarDayType,
  { label: string; short: string; cell: string; swatch: string }
> = {
  working: {
    label: "Working",
    short: "Working",
    cell: "bg-surface text-ink border-line",
    swatch: "bg-gray-200",
  },
  closed: {
    label: "Closed",
    short: "Closed",
    cell: "bg-gray-100 text-gray-400 border-line",
    swatch: "bg-gray-400",
  },
  extra_working: {
    label: "Extra working (pays +1 day)",
    short: "Extra",
    cell: "bg-amber-100 text-amber-900 border-amber-400",
    swatch: "bg-amber-400",
  },
  swapped_working: {
    label: "Swapped working (no extra pay)",
    short: "Swapped",
    cell: "bg-blue-50 text-blue-900 border-blue-300",
    swatch: "bg-blue-400",
  },
};

/** Order the day types are offered in the editor (safe first, costly last). */
export const DAY_TYPE_ORDER: CalendarDayType[] = [
  "working",
  "closed",
  "swapped_working",
  "extra_working",
];

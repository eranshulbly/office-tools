"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type RecomputeResult = { ok: true; message: string } | { error: string };

/**
 * Rebuilds attendance_days for the inclusive date range via the
 * `recompute_attendance` RPC (security definer — the only writer of that table).
 * The RPC is idempotent: running it twice produces identical output, so this is
 * always safe to re-run. We never write attendance_days directly.
 */
export async function recomputeAttendance(
  fromDate: string,
  toDate: string
): Promise<RecomputeResult> {
  if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) {
    return { error: "Both dates are required (YYYY-MM-DD)." };
  }
  if (fromDate > toDate) {
    return { error: "The From date must be on or before the To date." };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("recompute_attendance", {
    from_date: fromDate,
    to_date: toDate,
  });
  if (error) return { error: error.message };

  revalidatePath("/attendance");
  return { ok: true, message: `Recomputed attendance from ${fromDate} to ${toDate}.` };
}

export type DayRow = {
  day: string;
  status: string;
  worked_hours: number | string | null;
  first_in: string | null;
  last_out: string | null;
};

export type WorkerAttendance =
  | {
      rows: DayRow[];
      summary: {
        full_day: number;
        half_day: number;
        absent: number;
        unresolved: number;
        not_working_day: number;
        late_review: number;
        present: number;
        working_days: number;
        leave_units: number;
      };
    }
  | { error: string };

/**
 * Per-worker attendance over a date range (for the click-through summary popup).
 * Reads the derived attendance_days (RLS: SELECT for staff) and rolls up counts.
 */
export async function getWorkerAttendance(
  workerId: string,
  from: string,
  to: string
): Promise<WorkerAttendance> {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return { error: "Invalid date range." };
  if (from > to) return { error: "The From date must be on or before the To date." };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("attendance_days")
    .select("day, status, worked_hours, first_in, last_out")
    .eq("worker_id", workerId)
    .gte("day", from)
    .lte("day", to)
    .order("day");
  if (error) return { error: error.message };

  const rows = (data ?? []) as DayRow[];
  // half_day is legacy and never produced now; it stays in the shape but counts 0.
  const s = { full_day: 0, half_day: 0, absent: 0, unresolved: 0, not_working_day: 0, late_review: 0 };
  for (const r of rows) {
    if (r.status in s) s[r.status as keyof typeof s] += 1;
  }
  const present = s.full_day; // half_day is always 0 in the 2-state model
  const working_days = s.full_day + s.absent + s.unresolved + s.late_review; // excludes closed days
  const leave_units = s.absent; // = absent (half_day is always 0 now)

  return { rows, summary: { ...s, present, working_days, leave_units } };
}

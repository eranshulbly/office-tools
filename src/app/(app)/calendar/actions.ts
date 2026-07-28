"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import type { CalendarDayType } from "@/lib/types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID: CalendarDayType[] = ["working", "closed", "extra_working", "swapped_working"];

export type SetCalendarResult = { ok: true } | { error: string };

/**
 * Upserts a work_calendar row (onConflict day). Marking a day `extra_working`
 * costs +1 day's pay per worker (§3.2) — the caller must pass confirmExtra so the
 * cost is acknowledged explicitly, never as a quiet dropdown change.
 */
export async function setCalendarDay(input: {
  day: string;
  dayType: CalendarDayType;
  note: string;
  confirmExtra?: boolean;
  swapWith?: string;
}): Promise<SetCalendarResult> {
  const { day, dayType, note, confirmExtra, swapWith } = input;

  if (!DATE_RE.test(day)) return { error: "Invalid day." };
  if (!VALID.includes(dayType)) return { error: "Invalid day type." };
  if (dayType === "extra_working" && !confirmExtra) {
    return {
      error:
        "Marking a day extra_working must be explicitly confirmed — it pays every employee an extra day.",
    };
  }

  const profile = await getProfile();
  if (!profile) return { error: "Not authenticated." };
  if (profile.role !== "admin") return { error: "Only admins can edit the calendar." };

  const supabase = await createSupabaseServerClient();
  const stamp = { updated_by: profile.id, updated_at: new Date().toISOString() };

  // A SWAP is a paired change: this day opens as a normal working day and the
  // weekday given in `swapWith` closes in exchange. Both rows are written
  // together so the pairing is never left half-done (spec §3.2).
  if (dayType === "swapped_working") {
    if (!swapWith || !DATE_RE.test(swapWith)) {
      return { error: "Enter the working day being closed in exchange (the swapped date)." };
    }
    if (swapWith === day) {
      return { error: "The swapped date must be different from this day." };
    }
    const { error } = await supabase.from("work_calendar").upsert(
      [
        {
          day,
          day_type: "swapped_working",
          note: note.trim() ? note.trim() : `Swap: opened in place of ${swapWith}`,
          ...stamp,
        },
        {
          day: swapWith,
          day_type: "closed",
          note: `Swap: closed — work moved to ${day}`,
          ...stamp,
        },
      ],
      { onConflict: "day" }
    );
    if (error) return { error: error.message };
    revalidatePath("/calendar");
    return { ok: true };
  }

  const { error } = await supabase.from("work_calendar").upsert(
    {
      day,
      day_type: dayType,
      note: note.trim() ? note.trim() : null,
      ...stamp,
    },
    { onConflict: "day" }
  );
  if (error) return { error: error.message };

  revalidatePath("/calendar");
  return { ok: true };
}

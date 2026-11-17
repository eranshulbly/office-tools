"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ADJUSTMENT_REASONS, isAdjustmentReason } from "@/lib/adjustments";

export type AdjustmentFormState = { error?: string; ok?: boolean };

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/**
 * Manager requests a forgot-punch adjustment (spec §3.5). Inserts a pending row
 * with requested_by = current user (RLS requires requested_by = auth.uid() and
 * status 'pending'). The DB trigger blocks days inside a closed payroll run and
 * raises a human-readable message — surfaced verbatim below.
 */
export async function requestAdjustment(
  _prev: AdjustmentFormState,
  formData: FormData
): Promise<AdjustmentFormState> {
  const worker_id = str(formData, "worker_id");
  const day = str(formData, "day");
  const proposed_in = str(formData, "proposed_in");
  const proposed_out = str(formData, "proposed_out");
  const reason = str(formData, "reason");

  if (!worker_id) return { error: "Select an employee." };
  if (!day) return { error: "Day is required." };
  if (!reason) return { error: "A reason is required." };
  // The reason is a closed list, and it decides how the request is handled —
  // so it is checked here, not just in the dropdown. A server action is
  // reachable without the form, and an arbitrary string posted straight at it
  // would otherwise be stored and have to be read by a human.
  if (!isAdjustmentReason(reason)) {
    return { error: `Reason must be one of: ${ADJUSTMENT_REASONS.join(", ")}.` };
  }
  if (!proposed_in && !proposed_out)
    return { error: "Provide at least one of proposed IN or proposed OUT." };

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { error } = await supabase.from("adjustments").insert({
    worker_id,
    day,
    // timestamptz columns accept the datetime-local string, empty -> null.
    proposed_in: proposed_in || null,
    proposed_out: proposed_out || null,
    reason,
    status: "pending",
    requested_by: user.id,
  });
  if (error) return { error: error.message };

  revalidatePath("/adjustments");
  return { ok: true };
}

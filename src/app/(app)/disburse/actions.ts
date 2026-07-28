"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { notifyDisbursal } from "@/lib/notify";

export type ActionState = { error?: string; ok?: string };

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/**
 * Mark a single payroll line paid via the record_disbursal RPC. The RPC touches
 * ONLY payment fields (pay_mode, paid_at, paid_by, reference), advances the run
 * status, and closes it when the last line is paid. Never edits figures.
 */
export async function recordDisbursal(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const lineId = str(formData, "line_id");
  const mode = str(formData, "pay_mode");
  const reference = str(formData, "payment_reference") || null;
  const workerId = str(formData, "worker_id") || null;

  if (!lineId) return { error: "Missing line id." };
  if (mode !== "cash" && mode !== "online") {
    return { error: "Pay mode must be cash or online." };
  }

  const supabase = await createSupabaseServerClient();
  // record_disbursal enforces the manager group-scope; surface its error verbatim.
  const { error } = await supabase.rpc("record_disbursal", {
    p_line_id: lineId,
    p_mode: mode,
    p_reference: reference,
  });
  if (error) return { error: error.message };

  // Fire the (deferred) SMS hook. notifyDisbursal never throws, but guard anyway
  // so a notification issue can never fail or block a successful disbursal.
  if (workerId) {
    try {
      await notifyDisbursal(workerId);
    } catch {
      // ignore — disbursal already succeeded
    }
  }

  revalidatePath("/disburse");
  return { ok: "Marked paid." };
}

/**
 * Record cash handover for an APPROVED advance (advance disbursal) from the
 * Disburse tab. record_advance_disbursal permits admin or manager and guards
 * against double-disbursal / not-approved.
 */
export async function disburseAdvance(id: string): Promise<{ error?: string }> {
  if (!id) return { error: "Missing advance id." };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("record_advance_disbursal", { p_id: id });
  if (error) return { error: error.message };
  revalidatePath("/disburse");
  revalidatePath("/advances");
  return {};
}

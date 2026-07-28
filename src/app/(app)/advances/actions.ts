"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type AdvanceFormState = { error?: string; ok?: boolean };

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/**
 * Manager requests an advance (spec §3.7). Inserts a pending row with
 * requested_by = current user. The DB trigger enforce_advance_cap BLOCKS the
 * insert when outstanding + amount > salary × advance_cap_multiple and raises a
 * human-readable message — surfaced verbatim below (§3.7.3).
 */
export async function requestAdvance(
  _prev: AdvanceFormState,
  formData: FormData
): Promise<AdvanceFormState> {
  const worker_id = str(formData, "worker_id");
  const reason = str(formData, "reason");
  const amount = Number(str(formData, "amount"));

  if (!worker_id) return { error: "Select an employee." };
  if (!Number.isFinite(amount) || amount <= 0)
    return { error: "Amount must be a number greater than 0." };
  if (!reason) return { error: "A reason is required." };

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { error } = await supabase.from("advances").insert({
    worker_id,
    amount,
    reason,
    status: "pending",
    requested_by: user.id,
  });
  if (error) return { error: error.message };

  revalidatePath("/advances");
  return { ok: true };
}

/**
 * Manager records handing over the cash for an already-approved advance
 * (approval ≠ payment, §3.7.4). Sets disbursed_at via the RPC, which checks the
 * advance is approved and not already disbursed.
 */
export async function recordAdvanceDisbursal(
  _prev: AdvanceFormState,
  formData: FormData
): Promise<AdvanceFormState> {
  const p_id = str(formData, "p_id");
  if (!p_id) return { error: "Missing advance id." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("record_advance_disbursal", { p_id });
  if (error) return { error: error.message };

  revalidatePath("/advances");
  return { ok: true };
}

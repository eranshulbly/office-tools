"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** Shared shape for the small client forms in this module. */
export type ActionState = { error?: string; ok?: string };

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/**
 * Create a draft payroll run. Figures are NOT computed here — only the run row
 * (status defaults to 'draft'). Compute/approve happen via RPC on the detail page.
 */
export async function createRun(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const period_start = str(formData, "period_start");
  const period_end = str(formData, "period_end");
  const pay_date = str(formData, "pay_date");

  if (!period_start || !period_end || !pay_date) {
    return { error: "Period start, period end, and pay date are all required." };
  }
  if (period_start > period_end) {
    return { error: "Period start must be on or before period end." };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("payroll_runs")
    .insert({ period_start, period_end, pay_date })
    .select("id")
    .single();

  if (error) return { error: error.message };

  revalidatePath("/payroll");
  redirect(`/payroll/${data.id}`);
}

/**
 * Compute a draft run. The RPC re-derives all payroll_lines + components. It
 * RAISES (and we surface verbatim) if the period has unresolved attendance days
 * or pending adjustments — payroll refuses to run (spec §3.6).
 */
export async function computeRun(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const runId = str(formData, "run_id");
  if (!runId) return { error: "Missing run id." };

  const supabase = await createSupabaseServerClient();

  // #6 fix: rebuild attendance for the whole period first, so payroll can never
  // run on stale/uncomputed attendance (which would silently pay absent workers
  // in full). recompute is idempotent, so this is always safe.
  const { data: run, error: runErr } = await supabase
    .from("payroll_runs")
    .select("period_start, period_end")
    .eq("id", runId)
    .single();
  if (runErr || !run) return { error: runErr?.message ?? "Run not found." };

  const { error: recErr } = await supabase.rpc("recompute_attendance", {
    from_date: run.period_start,
    to_date: run.period_end,
  });
  if (recErr) return { error: recErr.message };

  const { error } = await supabase.rpc("compute_payroll_run", { p_run_id: runId });
  if (error) return { error: error.message };

  revalidatePath(`/payroll/${runId}`);
  return { ok: "Attendance recomputed and run computed. Review the breakdown, then approve." };
}

/** Approve a draft run — freezes figures and makes it visible to the manager. */
export async function approveRun(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const runId = str(formData, "run_id");
  if (!runId) return { error: "Missing run id." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("approve_payroll_run", { p_run_id: runId });
  if (error) return { error: error.message };

  revalidatePath(`/payroll/${runId}`);
  return { ok: "Run approved and frozen." };
}

/**
 * Reopen an admin_approved run back to draft. Loud, audited action; requires a
 * reason and is blocked by the RPC if any line is already paid.
 */
export async function reopenRun(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const runId = str(formData, "run_id");
  const reason = str(formData, "reason");
  if (!runId) return { error: "Missing run id." };
  if (!reason) return { error: "A reason is required to reopen a run." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("reopen_payroll_run", {
    p_run_id: runId,
    p_reason: reason,
  });
  if (error) return { error: error.message };

  revalidatePath(`/payroll/${runId}`);
  return { ok: "Run reopened to draft." };
}

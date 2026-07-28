"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type ActionResult = { ok: true } | { error: string };

/**
 * Approve/reject a forgot-punch adjustment (admin-only RPC). Rejections require
 * a non-empty reason — the SQL enforces it and so do we, so the message is clear
 * before we even round-trip. RPC errors are returned verbatim for the UI.
 */
export async function decideAdjustment(
  id: string,
  approve: boolean,
  reason: string
): Promise<ActionResult> {
  const trimmed = (reason ?? "").trim();
  if (!approve && trimmed === "") {
    return { error: "A reason is required to reject." };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("decide_adjustment", {
    p_id: id,
    p_approve: approve,
    p_reason: trimmed,
  });
  if (error) return { error: error.message };

  revalidatePath("/approvals");
  return { ok: true };
}

/** Approve/reject an advance request (admin-only RPC). Same reason rule. */
export async function decideAdvance(
  id: string,
  approve: boolean,
  reason: string
): Promise<ActionResult> {
  const trimmed = (reason ?? "").trim();
  if (!approve && trimmed === "") {
    return { error: "A reason is required to reject." };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("decide_advance", {
    p_id: id,
    p_approve: approve,
    p_reason: trimmed,
  });
  if (error) return { error: error.message };

  revalidatePath("/advance-approvals");
  return { ok: true };
}

// ── Plain-form adapters (approve buttons) ────────────────────────────────────
// Approve is a fire-and-revalidate <form action> with a hidden `id` input. These
// return void (the plain form discards any value); decideAdjustment/decideAdvance
// already revalidate. An approve RPC error is a rare edge (e.g. the row was
// decided concurrently, or its day fell into a closed run) — the queue simply
// re-renders unchanged rather than showing inline text on this path.

export async function approveAdjustmentAction(formData: FormData): Promise<void> {
  await decideAdjustment(String(formData.get("id") ?? ""), true, "");
}

export async function approveAdvanceAction(formData: FormData): Promise<void> {
  await decideAdvance(String(formData.get("id") ?? ""), true, "");
}

// ── Late-arrival reviews (folded into the Approvals queue) ───────────────────

/**
 * Approve or reject a held late-arrival day (admin-only RPC). Approve → present
 * (full_day); reject (needs a reason) → absent. The RPC recomputes the day.
 */
export async function decideLateReview(
  workerId: string,
  day: string,
  approve: boolean,
  reason: string
): Promise<ActionResult> {
  const trimmed = (reason ?? "").trim();
  if (!approve && trimmed === "") return { error: "A reason is required to reject." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("decide_late_review", {
    p_worker: workerId,
    p_day: day,
    p_approve: approve,
    p_reason: trimmed,
  });
  if (error) return { error: error.message };

  revalidatePath("/approvals");
  revalidatePath("/attendance");
  return { ok: true };
}

export async function approveLateReviewAction(formData: FormData): Promise<void> {
  await decideLateReview(
    String(formData.get("worker_id") ?? ""),
    String(formData.get("day") ?? ""),
    true,
    ""
  );
}

// ── New-worker requests (manager submits → admin adds pay/bank & activates) ───

/**
 * Approve a manager-submitted new worker: admin supplies the confidential
 * monthly salary (+ optional bank details) and the RPC activates the row. The
 * SQL raises if salary is not > 0 — that message is surfaced verbatim. Optional
 * bank fields are sent as null when blank.
 */
export async function approveNewWorker(
  workerId: string,
  salary: number,
  bankAccount: string,
  bankIfsc: string
): Promise<ActionResult> {
  const supabase = await createSupabaseServerClient();
  const acct = (bankAccount ?? "").trim();
  const ifsc = (bankIfsc ?? "").trim();
  const { error } = await supabase.rpc("approve_new_worker", {
    p_worker: workerId,
    p_salary: salary,
    p_bank_account: acct === "" ? null : acct,
    p_bank_ifsc: ifsc === "" ? null : ifsc,
  });
  if (error) return { error: error.message };

  revalidatePath("/approvals");
  revalidatePath("/workers");
  return { ok: true };
}

/** Plain-form adapter: reads worker_id, salary, bank_account, bank_ifsc. */
export async function approveNewWorkerAction(formData: FormData): Promise<ActionResult> {
  return approveNewWorker(
    String(formData.get("worker_id") ?? ""),
    Number(formData.get("salary") ?? 0),
    String(formData.get("bank_account") ?? ""),
    String(formData.get("bank_ifsc") ?? "")
  );
}

/** Reject a manager-submitted new worker (admin-only RPC). Reason required. */
export async function rejectNewWorker(workerId: string, reason: string): Promise<ActionResult> {
  const trimmed = (reason ?? "").trim();
  if (trimmed === "") return { error: "A reason is required to reject." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("reject_new_worker", {
    p_worker: workerId,
    p_reason: trimmed,
  });
  if (error) return { error: error.message };

  revalidatePath("/approvals");
  revalidatePath("/workers");
  return { ok: true };
}

// ── Manager-proposed edits to existing workers ───────────────────────────────

/**
 * Approve or reject a manager-proposed edit (admin-only RPC). Approve applies
 * the stored payload to the worker; reject needs a non-empty reason. RPC errors
 * are surfaced verbatim.
 */
export async function decideWorkerEdit(
  requestId: string,
  approve: boolean,
  reason: string
): Promise<ActionResult> {
  const trimmed = (reason ?? "").trim();
  if (!approve && trimmed === "") return { error: "A reason is required to reject." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("decide_worker_edit", {
    p_id: requestId,
    p_approve: approve,
    p_reason: trimmed,
  });
  if (error) return { error: error.message };

  revalidatePath("/approvals");
  revalidatePath("/workers");
  return { ok: true };
}

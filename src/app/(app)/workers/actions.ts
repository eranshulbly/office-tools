"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  PHOTO_BUCKET,
  ID_PROOF_BUCKET,
  uploadWorkerFile,
} from "@/lib/storage";

export type WorkerFormState = { error?: string };

type ParsedWorker = {
  full_name: string;
  monthly_salary: number;
  joined_on: string;
  left_on: string | null;
  is_active: boolean;
  group_id: string | null;
  phone: string | null;
  // Bank details are stored in the admin-only worker_bank_details table.
  bank_account: string | null;
  bank_ifsc: string | null;
};
// NB: employee_code is auto-assigned & fixed (never edited via a form); the
// device user ID (PIN) is not collected in the app forms.

/** Persist bank details to the admin-only table (kept out of the workers row). */
async function saveBankDetails(workerId: string, v: ParsedWorker): Promise<string | null> {
  if (v.bank_account === null && v.bank_ifsc === null) return null;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("worker_bank_details")
    .upsert(
      { worker_id: workerId, bank_account: v.bank_account, bank_ifsc: v.bank_ifsc, updated_at: new Date().toISOString() },
      { onConflict: "worker_id" }
    );
  return error ? error.message : null;
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

// Name: starts with a letter, then letters / spaces / . ' - (no digits), ≥2 chars.
const NAME_RE = /^[A-Za-z][A-Za-z .'-]{1,}$/;
// Phone: a 10-digit Indian mobile (starts 6–9), optional +91 / 91 prefix.
const PHONE_RE = /^(?:\+?91)?[6-9]\d{9}$/;

function nameError(name: string): string | null {
  return NAME_RE.test(name)
    ? null
    : "Enter a valid name — letters, spaces, and . ' - only (no digits).";
}
function phoneError(phone: string): string | null {
  return PHONE_RE.test(phone.replace(/[\s-]/g, ""))
    ? null
    : "Enter a valid 10-digit Indian mobile number (optionally with +91).";
}
/** Today in the warehouse timezone (IST), as yyyy-mm-dd for ISO date compares. */
function todayIST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}
function joinedOnError(joined_on: string): string | null {
  return joined_on > todayIST() ? "Joined on cannot be a future date." : null;
}

/** A File from the form, or null when no file was chosen. */
function file(formData: FormData, key: string): File | null {
  const f = formData.get(key);
  return f instanceof File && f.size > 0 ? f : null;
}

/**
 * Upload the optional photo / id-proof for a worker and persist their paths.
 * Best-effort: a storage failure is surfaced but does not roll back the worker
 * row (photo/id proof are optional and can be added later).
 */
async function attachFiles(workerId: string, formData: FormData): Promise<string | null> {
  const photo = file(formData, "photo");
  const idProof = file(formData, "id_proof");
  if (!photo && !idProof) return null;

  const update: { photo_path?: string; id_proof_path?: string } = {};
  if (photo) {
    const r = await uploadWorkerFile(PHOTO_BUCKET, workerId, photo, "photo");
    if (r && "error" in r) return `Photo upload failed: ${r.error}`;
    if (r && "path" in r) update.photo_path = r.path;
  }
  if (idProof) {
    const r = await uploadWorkerFile(ID_PROOF_BUCKET, workerId, idProof, "idproof");
    if (r && "error" in r) return `ID proof upload failed: ${r.error}`;
    if (r && "path" in r) update.id_proof_path = r.path;
  }

  if (Object.keys(update).length > 0) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.from("workers").update(update).eq("id", workerId);
    if (error) return error.message;
  }
  return null;
}

function parseWorker(formData: FormData): ParsedWorker {
  const bank_account = str(formData, "bank_account");
  const bank_ifsc = str(formData, "bank_ifsc");
  const left_on = str(formData, "left_on");
  const group_id = str(formData, "group_id");
  const phone = str(formData, "phone");
  return {
    full_name: str(formData, "full_name"),
    monthly_salary: Number(str(formData, "monthly_salary")),
    bank_account: bank_account || null,
    bank_ifsc: bank_ifsc || null,
    joined_on: str(formData, "joined_on"),
    left_on: left_on || null,
    is_active: formData.get("is_active") != null,
    group_id: group_id || null,
    phone: phone || null,
  };
}

/**
 * Field-level validation — same mandatory fields for create AND edit: full name,
 * a positive monthly salary, phone, group, and joined-on. (Employee code is auto/
 * fixed; the device PIN isn't collected here.)
 */
function validate(v: ParsedWorker): string | null {
  if (!v.full_name) return "Full name is required.";
  const nErr = nameError(v.full_name);
  if (nErr) return nErr;
  if (!Number.isFinite(v.monthly_salary) || v.monthly_salary <= 0)
    return "Monthly salary must be a number greater than 0.";
  if (!v.phone) return "Phone number is required.";
  const pErr = phoneError(v.phone);
  if (pErr) return pErr;
  if (!v.group_id) return "Please choose a group.";
  if (!v.joined_on) return "Joined on date is required.";
  return joinedOnError(v.joined_on);
}

export async function createWorker(
  _prev: WorkerFormState,
  formData: FormData
): Promise<WorkerFormState> {
  const values = parseWorker(formData);
  const invalid = validate(values);
  if (invalid) return { error: invalid };

  const supabase = await createSupabaseServerClient();
  // employee_code is omitted → the workers.employee_code DEFAULT (next_employee_code)
  // auto-assigns a sequential EMP-#### code. No device PIN is collected here.
  const { data, error } = await supabase
    .from("workers")
    .insert({
      full_name: values.full_name,
      monthly_salary: values.monthly_salary,
      joined_on: values.joined_on,
      left_on: values.left_on,
      is_active: values.is_active,
      group_id: values.group_id,
      phone: values.phone,
    })
    .select("id")
    .single();
  if (error) return { error: error.message };

  const bankErr = await saveBankDetails(data.id as string, values);
  if (bankErr) return { error: bankErr };

  // Optional photo + id proof (uploaded after we have the worker id for the path).
  const fileErr = await attachFiles(data.id as string, formData);
  if (fileErr) return { error: fileErr };

  revalidatePath("/workers");
  redirect("/workers");
}

export async function updateWorker(
  _prev: WorkerFormState,
  formData: FormData
): Promise<WorkerFormState> {
  const id = str(formData, "id");
  if (!id) return { error: "Missing employee id." };

  const values = parseWorker(formData);
  const invalid = validate(values);
  if (invalid) return { error: invalid };

  // Making an employee inactive with no leaving date → record today as the date.
  const today = todayIST();
  if (!values.is_active && !values.left_on) {
    values.left_on = today;
  }
  // A worker whose leaving date has passed is no longer active — keep the flag
  // in sync so lists, dashboards, and payroll all agree.
  if (values.left_on && values.left_on <= today) {
    values.is_active = false;
  }

  const supabase = await createSupabaseServerClient();
  // employee_code and device PIN are intentionally NOT updated here (code is
  // fixed; PIN isn't managed in this form) — they're left untouched.
  const { error } = await supabase
    .from("workers")
    .update({
      full_name: values.full_name,
      monthly_salary: values.monthly_salary,
      joined_on: values.joined_on,
      left_on: values.left_on,
      is_active: values.is_active,
      group_id: values.group_id,
      phone: values.phone,
    })
    .eq("id", id);
  if (error) return { error: error.message };

  const bankErr = await saveBankDetails(id, values);
  if (bankErr) return { error: bankErr };

  // Replace photo / id proof if new files were provided (existing ones kept otherwise).
  const fileErr = await attachFiles(id, formData);
  if (fileErr) return { error: fileErr };

  revalidatePath("/workers");
  revalidatePath(`/workers/${id}`);
  redirect("/workers");
}

// ─── Manager flows (pending admin approval) ──────────────────────────────────
// Managers cannot write the workers table directly (RLS); everything below goes
// through security-definer RPCs that create PENDING records only.

export type ManagerFormState = { error?: string; ok?: boolean };

/**
 * Manager submits a NEW worker. Creates it PENDING + inactive with null salary
 * (no salary/bank ever collected from a manager). Returns the new worker id from
 * the RPC, then best-effort uploads the optional photo / id proof.
 */
export async function requestNewWorker(
  _prev: ManagerFormState,
  formData: FormData
): Promise<ManagerFormState> {
  const full_name = str(formData, "full_name");
  const group_id = str(formData, "group_id");
  const joined_on = str(formData, "joined_on");
  const phone = str(formData, "phone");

  // Employee code is auto-assigned by the RPC. No device PIN collected here.
  if (!full_name) return { error: "Full name is required." };
  const nErr = nameError(full_name);
  if (nErr) return { error: nErr };
  if (!phone) return { error: "Phone number is required." };
  const pErr = phoneError(phone);
  if (pErr) return { error: pErr };
  if (!group_id) return { error: "Please choose a group." };
  if (!joined_on) return { error: "Joined on date is required." };
  const jErr = joinedOnError(joined_on);
  if (jErr) return { error: jErr };

  const payload = { full_name, joined_on, phone, group_id };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("request_new_worker", { p: payload });
  if (error) return { error: error.message };

  const workerId = data as string;

  // Upload the optional files, then persist their storage paths. A manager
  // cannot UPDATE the workers row directly (RLS blocks it), so the paths are
  // recorded through the security-definer set_worker_media RPC, which lets the
  // manager who created a still-pending worker store photo_path / id_proof_path.
  const photo = file(formData, "photo");
  const idProof = file(formData, "id_proof");
  let photoPath: string | null = null;
  let idProofPath: string | null = null;
  if (photo) {
    const r = await uploadWorkerFile(PHOTO_BUCKET, workerId, photo, "photo");
    if (r && "error" in r) return { error: `Photo upload failed: ${r.error}` };
    if (r && "path" in r) photoPath = r.path;
  }
  if (idProof) {
    const r = await uploadWorkerFile(ID_PROOF_BUCKET, workerId, idProof, "idproof");
    if (r && "error" in r) return { error: `ID proof upload failed: ${r.error}` };
    if (r && "path" in r) idProofPath = r.path;
  }

  if (photoPath || idProofPath) {
    const { error: mediaErr } = await supabase.rpc("set_worker_media", {
      p_worker: workerId,
      p_photo_path: photoPath ?? "",
      p_id_proof_path: idProofPath ?? "",
    });
    if (mediaErr) return { error: mediaErr.message };
  }

  revalidatePath("/workers");
  return { ok: true };
}

/**
 * Manager proposes an EDIT to a worker in one of their groups. Stored as a
 * pending change (the live worker row is untouched until an admin approves).
 * Only non-confidential fields are ever submitted — never salary or bank.
 */
export async function requestWorkerEdit(
  workerId: string,
  _prev: ManagerFormState,
  formData: FormData
): Promise<ManagerFormState> {
  if (!workerId) return { error: "Missing employee id." };

  const full_name = str(formData, "full_name");
  const group_id = str(formData, "group_id");
  const joined_on = str(formData, "joined_on");
  const left_on = str(formData, "left_on");
  const phone = str(formData, "phone");

  // Same mandatory fields as the new-employee form. Employee code (fixed) and the
  // device PIN are never edited here.
  if (!full_name) return { error: "Full name is required." };
  const nErr = nameError(full_name);
  if (nErr) return { error: nErr };
  if (!phone) return { error: "Phone number is required." };
  const pErr = phoneError(phone);
  if (pErr) return { error: pErr };
  if (!group_id) return { error: "Please choose a group." };
  if (!joined_on) return { error: "Joined on date is required." };
  const is_active = formData.get("is_active") != null;

  const supabase = await createSupabaseServerClient();

  // Compare against the live worker so we submit ONLY the fields that actually
  // changed — and reject a no-op submission outright.
  const { data: cur, error: curErr } = await supabase
    .from("workers")
    .select("full_name, group_id, phone, joined_on, left_on, is_active")
    .eq("id", workerId)
    .single();
  if (curErr || !cur) return { error: curErr?.message ?? "Employee not found." };

  // Making inactive without a date → leaving date = today (the request date).
  const effectiveLeftOn = !is_active && !left_on ? todayIST() : left_on;

  const payload: Record<string, string | boolean> = {};
  if (full_name !== (cur.full_name ?? "")) payload.full_name = full_name;
  if (group_id !== (cur.group_id ?? "")) payload.group_id = group_id;
  if (phone !== (cur.phone ?? "")) payload.phone = phone;
  if (joined_on !== (cur.joined_on ?? "")) payload.joined_on = joined_on;
  if (effectiveLeftOn !== (cur.left_on ?? "")) payload.left_on = effectiveLeftOn;
  if (is_active !== !!cur.is_active) payload.is_active = is_active;

  const hasFieldChanges = Object.keys(payload).length > 0;

  // Photo / id proof are not confidential pay fields — apply them IMMEDIATELY via
  // set_worker_media (RLS lets a manager set media for a worker in their group).
  const photo = file(formData, "photo");
  const idProof = file(formData, "id_proof");
  const hasFiles = !!photo || !!idProof;

  if (!hasFieldChanges && !hasFiles) {
    return { error: "No changes to submit." };
  }

  if (hasFiles) {
    let photoPath: string | null = null;
    let idProofPath: string | null = null;
    if (photo) {
      const r = await uploadWorkerFile(PHOTO_BUCKET, workerId, photo, "photo");
      if (r && "error" in r) return { error: `Photo upload failed: ${r.error}` };
      if (r && "path" in r) photoPath = r.path;
    }
    if (idProof) {
      const r = await uploadWorkerFile(ID_PROOF_BUCKET, workerId, idProof, "idproof");
      if (r && "error" in r) return { error: `ID proof upload failed: ${r.error}` };
      if (r && "path" in r) idProofPath = r.path;
    }
    if (photoPath || idProofPath) {
      const { error: mediaErr } = await supabase.rpc("set_worker_media", {
        p_worker: workerId,
        p_photo_path: photoPath ?? "",
        p_id_proof_path: idProofPath ?? "",
      });
      if (mediaErr) return { error: mediaErr.message };
    }
  }

  if (hasFieldChanges) {
    const { error } = await supabase.rpc("request_worker_edit", { p_worker: workerId, p: payload });
    if (error) return { error: error.message };
  }

  revalidatePath("/workers");
  revalidatePath(`/workers/${workerId}`);
  return { ok: true };
}

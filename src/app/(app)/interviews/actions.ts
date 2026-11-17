"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "crypto";
import { requireFeature } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { putObject, deleteObject } from "@/lib/storage/s3";
import type { CandidateStatus } from "@/lib/types";

export type CandidateActionState = { error?: string; ok?: boolean };

/**
 * Resumes are stored in S3, never on the instance disk and never in the
 * database. The object key is kept on the candidate row; the file itself is
 * only ever served through the authenticated download route.
 *
 * Prefix keeps the bucket usable for other apps later.
 */
const KEY_PREFIX = "resumes/";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — a resume with photos, comfortably
const ALLOWED = new Map<string, string>([
  ["application/pdf", "pdf"],
  ["application/msword", "doc"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

function str(fd: FormData, k: string): string {
  return String(fd.get(k) ?? "").trim();
}

/**
 * Upload the resume to S3 under a generated key.
 *
 * The key is a UUID, never the user's filename. An uploaded name like
 * "../../.env" is then inert — it is kept only as a label to display and to
 * name the download.
 */
async function storeResume(
  file: File
): Promise<{ path: string; name: string; mime: string; size: number } | null> {
  if (!file || file.size === 0) return null;
  if (file.size > MAX_BYTES) {
    throw new Error(`Resume is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 5 MB.`);
  }
  const ext = ALLOWED.get(file.type);
  if (!ext) throw new Error("Resume must be a PDF, Word document, or image.");

  const key = `${KEY_PREFIX}${randomUUID()}.${ext}`;
  await putObject(key, Buffer.from(await file.arrayBuffer()), file.type);

  return {
    path: key,
    name: file.name.slice(0, 200) || `resume.${ext}`,
    mime: file.type,
    size: file.size,
  };
}

export async function addCandidate(
  _prev: CandidateActionState,
  formData: FormData
): Promise<CandidateActionState> {
  const profile = await requireFeature("candidates");

  const fullName = str(formData, "full_name");
  if (!fullName) return { error: "Candidate name is required." };

  let resume: Awaited<ReturnType<typeof storeResume>> = null;
  try {
    resume = await storeResume(formData.get("resume") as File);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not read the resume." };
  }

  const db = await createSupabaseServerClient();
  const { error } = await db.from("candidates").insert({
    id: randomUUID(),
    full_name: fullName,
    reference: str(formData, "reference") || null,
    phone: str(formData, "phone") || null,
    position: str(formData, "position") || null,
    area: str(formData, "area") || null,
    notes: str(formData, "notes") || null,
    resume_name: resume?.name ?? null,
    resume_path: resume?.path ?? null,
    resume_mime: resume?.mime ?? null,
    resume_size: resume?.size ?? null,
    created_by: profile.id,
  });

  if (error) {
    // Don't leave an orphaned object in the bucket if the row never landed —
    // it would be unreferenced and invisible, quietly costing storage forever.
    if (resume) await deleteObject(resume.path).catch(() => {});
    return { error: error.message };
  }

  revalidatePath("/interviews");
  return { ok: true };
}

/**
 * Edit a candidate's details after they were added.
 *
 * Everything except the interview history is editable — names get misspelled
 * and phone numbers get corrected. A new resume REPLACES the old one, and the
 * old S3 object is deleted afterwards so the bucket doesn't accumulate
 * unreferenced files.
 */
export async function updateCandidate(
  _prev: CandidateActionState,
  formData: FormData
): Promise<CandidateActionState> {
  await requireFeature("candidates");

  const id = str(formData, "id");
  const fullName = str(formData, "full_name");
  if (!id) return { error: "Missing candidate." };
  if (!fullName) return { error: "Candidate name is required." };

  const db = await createSupabaseServerClient();

  // Read the current key first: if the replacement upload fails we must not
  // have already forgotten where the existing resume lives.
  const { data: existing } = await db
    .from("candidates").select("resume_path").eq("id", id).maybeSingle();
  const oldPath = (existing as { resume_path: string | null } | null)?.resume_path ?? null;

  let resume: Awaited<ReturnType<typeof storeResume>> = null;
  try {
    resume = await storeResume(formData.get("resume") as File);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not read the resume." };
  }

  const patch: Record<string, unknown> = {
    full_name: fullName,
    reference: str(formData, "reference") || null,
    phone: str(formData, "phone") || null,
    position: str(formData, "position") || null,
    area: str(formData, "area") || null,
    notes: str(formData, "notes") || null,
  };
  if (resume) {
    patch.resume_name = resume.name;
    patch.resume_path = resume.path;
    patch.resume_mime = resume.mime;
    patch.resume_size = resume.size;
  }

  const { error } = await db.from("candidates").update(patch).eq("id", id);
  if (error) {
    // The row didn't change, so drop the object we just uploaded.
    if (resume) await deleteObject(resume.path).catch(() => {});
    return { error: error.message };
  }

  // Only once the row points at the new file is the old one safe to remove.
  if (resume && oldPath && oldPath !== resume.path) {
    await deleteObject(oldPath).catch(() => {});
  }

  revalidatePath(`/interviews/${id}`);
  revalidatePath("/interviews");
  return { ok: true };
}

/**
 * Record notes from one interview round.
 *
 * Notes are append-only: there is no edit or delete. An interview record that
 * can be quietly rewritten later is worth very little, and the round number
 * plus timestamp already give a readable history. Two interviewers in the same
 * round each add their own note rather than sharing one field.
 */
export async function addRound(
  _prev: CandidateActionState,
  formData: FormData
): Promise<CandidateActionState> {
  const profile = await requireFeature("candidates");

  const candidateId = str(formData, "candidate_id");
  const notes = str(formData, "notes");
  const roundNo = Number(str(formData, "round_no") || "1");

  if (!candidateId) return { error: "Missing candidate." };
  if (!notes) return { error: "Write the interview notes before saving." };
  if (!Number.isInteger(roundNo) || roundNo < 1 || roundNo > 20) {
    return { error: "Round must be a number between 1 and 20." };
  }

  const outcome = str(formData, "outcome") || "pending";
  if (!["pending", "pass", "fail"].includes(outcome)) {
    return { error: "Invalid round outcome." };
  }

  const db = await createSupabaseServerClient();
  const { error } = await db.from("interview_rounds").insert({
    id: randomUUID(),
    candidate_id: candidateId,
    round_no: roundNo,
    round_name: str(formData, "round_name") || null,
    outcome,
    notes,
    interviewer: str(formData, "interviewer") || null,
    interviewed_on: str(formData, "interviewed_on") || null,
    created_by: profile.id,
  });
  if (error) return { error: error.message };

  revalidatePath(`/interviews/${candidateId}`);
  revalidatePath("/interviews");
  return { ok: true };
}

/**
 * Move a candidate to shortlisted or rejected, recording who decided and why.
 * A rejection requires a reason — the same rule the cheque and advance
 * decisions use, so a "no" is never unexplained months later.
 */
export async function setCandidateStatus(
  id: string,
  status: CandidateStatus,
  reason?: string
): Promise<CandidateActionState> {
  const profile = await requireFeature("candidates");
  if (!id) return { error: "Missing candidate." };

  const trimmed = (reason ?? "").trim();
  if (status === "rejected" && !trimmed) return { error: "A rejection needs a reason." };

  const db = await createSupabaseServerClient();
  const { error } = await db
    .from("candidates")
    .update({
      status,
      decision_reason: status === "new" ? null : trimmed || null,
      decided_by: status === "new" ? null : profile.id,
      // Reverting to "new" clears the decision rather than leaving a stale one.
      decided_at: status === "new" ? null : new Date().toISOString().slice(0, 23).replace("T", " "),
    })
    .eq("id", id);

  if (error) return { error: error.message };
  revalidatePath("/interviews");
  return { ok: true };
}

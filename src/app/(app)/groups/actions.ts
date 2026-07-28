"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type GroupFormState = { error?: string; ok?: boolean };

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/** Create a worker group. Admin-only; group names are unique in the DB. */
export async function createGroup(
  _prev: GroupFormState,
  formData: FormData
): Promise<GroupFormState> {
  await requireRole("admin");
  const name = str(formData, "name");
  if (!name) return { error: "Group name is required." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("worker_groups").insert({ name });
  if (error) return { error: error.message };

  revalidatePath("/groups");
  return { ok: true };
}

/**
 * Delete a group. Blocked if any worker still belongs to it — the admin must
 * move those workers out first. We check explicitly so we can surface a clear
 * message rather than a raw FK error.
 */
export async function deleteGroup(
  _prev: GroupFormState,
  formData: FormData
): Promise<GroupFormState> {
  await requireRole("admin");
  const id = str(formData, "id");
  if (!id) return { error: "Missing group id." };

  const supabase = await createSupabaseServerClient();
  const { count, error: countErr } = await supabase
    .from("workers")
    .select("id", { count: "exact", head: true })
    .eq("group_id", id);
  if (countErr) return { error: countErr.message };
  if ((count ?? 0) > 0)
    return {
      error: `This group still has ${count} employee(s). Remove them from the group first.`,
    };

  const { error } = await supabase.from("worker_groups").delete().eq("id", id);
  if (error) return { error: error.message };

  revalidatePath("/groups");
  return { ok: true };
}

/**
 * Set (or clear) a worker's group. An empty group id detaches the worker
 * (group_id → null = ungrouped).
 */
export async function setWorkerGroup(
  _prev: GroupFormState,
  formData: FormData
): Promise<GroupFormState> {
  await requireRole("admin");
  const workerId = str(formData, "worker_id");
  if (!workerId) return { error: "Missing employee id." };
  const groupId = str(formData, "group_id");

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("workers")
    .update({ group_id: groupId || null })
    .eq("id", workerId);
  if (error) return { error: error.message };

  revalidatePath("/groups");
  return { ok: true };
}

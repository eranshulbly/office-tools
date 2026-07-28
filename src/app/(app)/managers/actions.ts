"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type ManagerFormState = { error?: string; ok?: boolean };

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/**
 * Create a manager account: an auth user + a profiles row with role='manager'.
 * Admin-only. Uses the service-role client to create the auth user (something
 * the logged-in admin can't do via RLS), gated behind requireRole("admin").
 */
export async function createManager(
  _prev: ManagerFormState,
  formData: FormData
): Promise<ManagerFormState> {
  await requireRole("admin");

  const fullName = str(formData, "full_name");
  const email = str(formData, "email");
  const password = str(formData, "password");

  if (!fullName) return { error: "Full name is required." };
  if (!email) return { error: "Email is required." };
  if (password.length < 8) return { error: "Password must be at least 8 characters." };

  const admin = createSupabaseAdminClient();
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (createErr) return { error: createErr.message };
  const newUser = created.user;
  if (!newUser) return { error: "Could not create the account." };

  const { error: profileErr } = await admin
    .from("profiles")
    .upsert({ id: newUser.id, full_name: fullName, role: "manager" });
  if (profileErr) return { error: profileErr.message };

  revalidatePath("/managers");
  return { ok: true };
}

/**
 * Replace a manager's disbursal access to exactly the given group ids: delete
 * all their existing manager_group_access rows, then insert the new set. Normal
 * server client — admin RLS permits this.
 */
export async function setManagerGroups(
  _prev: ManagerFormState,
  formData: FormData
): Promise<ManagerFormState> {
  await requireRole("admin");

  const managerId = str(formData, "manager_id");
  if (!managerId) return { error: "Missing manager id." };
  const groupIds = formData.getAll("group_ids").map((g) => String(g)).filter(Boolean);

  const supabase = await createSupabaseServerClient();

  const { error: delErr } = await supabase
    .from("manager_group_access")
    .delete()
    .eq("manager_id", managerId);
  if (delErr) return { error: delErr.message };

  if (groupIds.length > 0) {
    const rows = groupIds.map((group_id) => ({ manager_id: managerId, group_id }));
    const { error: insErr } = await supabase.from("manager_group_access").insert(rows);
    if (insErr) return { error: insErr.message };
  }

  revalidatePath("/managers");
  return { ok: true };
}

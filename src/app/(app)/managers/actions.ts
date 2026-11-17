"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { transaction, query } from "@/lib/db/pool";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";

export type ManagerFormState = { error?: string; ok?: boolean };

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/**
 * Create a manager account: an auth_users row + a profiles row with
 * role='manager'. Admin-only.
 *
 * Previously this used the Supabase service-role client. With Supabase gone,
 * the app owns its own auth table, so the account is written directly — and in
 * a TRANSACTION, because the two rows are meaningless apart: an auth_users row
 * without a profile is a login that resolves to no role, and a profile without
 * an auth row is a person who can never sign in.
 */
export async function createManager(
  _prev: ManagerFormState,
  formData: FormData
): Promise<ManagerFormState> {
  await requireRole("admin");

  const fullName = str(formData, "full_name");
  const email = str(formData, "email").toLowerCase();
  const password = str(formData, "password");

  if (!fullName) return { error: "Full name is required." };
  if (!email) return { error: "Email is required." };
  if (password.length < 8) return { error: "Password must be at least 8 characters." };

  // Checked up front for a readable message; auth_users also has a UNIQUE key
  // on email, which is what actually guarantees it under a race.
  const taken = await query<{ id: string }>(
    "SELECT id FROM auth_users WHERE email = ? LIMIT 1",
    [email]
  );
  if (taken.length) return { error: "That email already has an account." };

  try {
    await transaction(async (conn) => {
      const id = randomUUID();
      // Cost 10, matching every other hash in the table.
      const hash = await bcrypt.hash(password, 10);
      await conn.query(
        "INSERT INTO auth_users (id, email, encrypted_password) VALUES (?, ?, ?)",
        [id, email, hash]
      );
      await conn.query(
        `INSERT INTO profiles (id, full_name, role) VALUES (?, ?, 'manager')
         ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), role = VALUES(role)`,
        [id, fullName]
      );
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/duplicate|ER_DUP_ENTRY/i.test(msg)) return { error: "That email already has an account." };
    return { error: msg };
  }

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

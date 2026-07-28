import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Profile, Role } from "@/lib/types";
import { GATED_SUITES } from "@/lib/suites";

/**
 * Returns the current user's profile (id, name, role) or null. Reads from the
 * profiles table, which is the source of truth for role.
 */
export async function getProfile(): Promise<Profile | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, role, full_access, created_at")
    .eq("id", user.id)
    .single();

  return (data as Profile) ?? null;
}

/**
 * Block a restricted manager (role=manager, full_access=false) from a gated
 * suite (HR / Payroll). Admins and full-access managers pass. Redirects home.
 * Call after requireRole on the manager-accessible HR/Payroll pages.
 */
export function requireSuiteAccess(profile: Profile, suiteKey: string): void {
  if (profile.role !== "admin" && GATED_SUITES.includes(suiteKey) && !profile.full_access) {
    redirect("/");
  }
}

/** Require a logged-in user; redirect to /login otherwise. */
export async function requireProfile(): Promise<Profile> {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  return profile;
}

/**
 * Require one of the allowed roles. Cosmetic vs RLS (which is the real gate),
 * but keeps users out of screens they can't use. Redirects home on mismatch.
 */
export async function requireRole(...allowed: Role[]): Promise<Profile> {
  const profile = await requireProfile();
  if (!allowed.includes(profile.role)) redirect("/");
  return profile;
}

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Profile, Role } from "@/lib/types";
import { GATED_SUITES, FEATURES, featuresForSuite } from "@/lib/suites";

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
 * Require one of the allowed roles. Redirects home on mismatch.
 *
 * Prefer `requireFeature` on pages — see the note there. This stays for server
 * actions, where the permission to *perform* something is often narrower than
 * the permission to see the page it lives on.
 */
export async function requireRole(...allowed: Role[]): Promise<Profile> {
  const profile = await requireProfile();
  if (!allowed.includes(profile.role)) redirect("/");
  return profile;
}

/**
 * Guard a page with the roles declared for its feature in the registry.
 *
 * The registry (src/lib/suites.ts) already decides which tiles and tabs a role
 * sees. Repeating that list in each page's requireRole() meant the same policy
 * lived in two places with nothing keeping them in step — and they did drift:
 * ops_manager was added to the registry, so the tile appeared, but the page
 * guard still rejected it and bounced the user home.
 *
 * Reading the roles from the registry makes that impossible: a role that can
 * see the tile can open the page, by construction.
 *
 * Unknown keys throw rather than redirect — a typo is a bug to surface at once,
 * not a silent lockout that looks like a permissions decision.
 */
export async function requireFeature(featureKey: string): Promise<Profile> {
  const feature = FEATURES.find((f) => f.key === featureKey);
  if (!feature) throw new Error(`requireFeature: no feature named "${featureKey}"`);
  const profile = await requireProfile();
  if (!feature.roles.includes(profile.role)) redirect("/");
  return profile;
}

/**
 * Guard a page that belongs to a suite but is not itself a feature — the cheque
 * firm picker, for example. Any role with at least one feature in that suite
 * may enter, because requireFirm() redirects here: excluding a role that can
 * reach a tab would deadlock it out of the suite entirely.
 */
export async function requireSuite(suiteKey: string): Promise<Profile> {
  const profile = await requireProfile();
  if (featuresForSuite(suiteKey, profile.role, profile.full_access).length === 0) redirect("/");
  return profile;
}

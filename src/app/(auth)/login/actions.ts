"use server";

import { cookies } from "next/headers";
import { verifyCredentials, issueToken, sessionCookie } from "@/lib/db/session";

/**
 * Sign in against auth_users (replacing Supabase Auth).
 *
 * This is a server action rather than a browser call: the password must never
 * reach a client-side SDK now that we own the check, and the session cookie is
 * httpOnly so client JavaScript cannot read it either.
 */
export async function signIn(
  _prev: { error: string | null } | null,
  formData: FormData
): Promise<{ error: string | null }> {
  const raw = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!raw || !password) return { error: "Enter your username and password." };

  // A bare username maps to the internal email, as before.
  const email = raw.includes("@") ? raw : `${raw}@warehouse.local`;

  const user = await verifyCredentials(email, password);
  // Deliberately vague: distinguishing "no such user" from "wrong password"
  // would let someone enumerate accounts.
  if (!user) return { error: "Invalid login credentials" };

  const jar = await cookies();
  jar.set(sessionCookie.name, issueToken(user.id), sessionCookie.options);
  return { error: null };
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  jar.set(sessionCookie.name, "", { ...sessionCookie.options, maxAge: 0 });
}

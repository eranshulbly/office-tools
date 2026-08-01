import { createHmac, timingSafeEqual, randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { query } from "./pool";

/**
 * Session auth, replacing Supabase Auth.
 *
 * Supabase hashed passwords with bcrypt and those hashes migrated across in
 * `auth_users.encrypted_password`, so existing passwords keep working and
 * nobody has to reset anything.
 *
 * Sessions are stateless: a signed, expiring token in an httpOnly cookie.
 * There is no session table to clean up, and nothing to look up per request
 * beyond the profile itself. HMAC-SHA256 via node:crypto — no JWT dependency
 * needed for a two-user, single-issuer system.
 */

const COOKIE = "wo_session";
const MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 days, matching the old Supabase default

export type AuthUser = { id: string; email: string };

function secret(): Buffer {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error("SESSION_SECRET must be set and at least 32 characters");
  }
  return Buffer.from(s, "utf8");
}

function b64url(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function sign(payload: string): string {
  return b64url(createHmac("sha256", secret()).update(payload).digest());
}

export function issueToken(userId: string): string {
  const body = b64url(
    Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + MAX_AGE_SEC }))
  );
  return `${body}.${sign(body)}`;
}

/** Verify signature and expiry. Returns the user id, or null. */
export function readToken(token: string | undefined): string | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expected = sign(body);
  // Constant-time compare so a forged token can't be tuned byte by byte.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const claims = JSON.parse(unb64url(body).toString("utf8")) as { sub?: string; exp?: number };
    if (!claims.sub || !claims.exp) return null;
    if (claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

export const sessionCookie = {
  name: COOKIE,
  options: {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SEC,
  },
};

/** Verify email + password against auth_users. Returns null on any failure. */
export async function verifyCredentials(
  email: string,
  password: string
): Promise<AuthUser | null> {
  const rows = await query<{ id: string; email: string; encrypted_password: string }>(
    "SELECT id, email, encrypted_password FROM auth_users WHERE email = ? LIMIT 1",
    [email.trim().toLowerCase()]
  );
  const u = rows[0];

  // Hash even when the user does not exist, so a missing account and a wrong
  // password take the same time and can't be told apart by probing.
  const hash = u?.encrypted_password ?? "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid";
  const ok = await bcrypt.compare(password, hash);
  if (!u || !ok) return null;

  await query("UPDATE auth_users SET last_sign_in_at = UTC_TIMESTAMP(6) WHERE id = ?", [u.id]);
  return { id: u.id, email: u.email };
}

/** Create a user (used by the seed script and admin-created manager accounts). */
export async function createUser(email: string, password: string): Promise<string> {
  const id = randomUUID();
  const hash = await bcrypt.hash(password, 10);
  await query(
    "INSERT INTO auth_users (id, email, encrypted_password) VALUES (?, ?, ?)",
    [id, email.trim().toLowerCase(), hash]
  );
  return id;
}

export async function setPassword(userId: string, password: string): Promise<void> {
  const hash = await bcrypt.hash(password, 10);
  await query("UPDATE auth_users SET encrypted_password = ? WHERE id = ?", [hash, userId]);
}

function randomUUID(): string {
  // node:crypto randomUUID, via randomBytes so this stays available on any
  // runtime the app is bundled for.
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

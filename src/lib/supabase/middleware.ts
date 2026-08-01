import { NextResponse, type NextRequest } from "next/server";
import { readToken, sessionCookie } from "@/lib/db/session";

/**
 * Gate unauthenticated requests, redirecting to /login.
 *
 * The Supabase version made a network call to refresh the session on EVERY
 * request. Sessions are now self-contained signed tokens, so this verifies the
 * cookie locally — no database or network round trip in the hot path.
 *
 * This is a UX guard only. It checks that a session token is valid and
 * unexpired; it does not know the user's role. Authorization lives in the data
 * layer (src/lib/db/authz.ts) — reaching a page is not permission to see what
 * is on it.
 */
export async function updateSession(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isPublic = path.startsWith("/login") || path.startsWith("/auth");

  const userId = readToken(request.cookies.get(sessionCookie.name)?.value);

  if (!userId && !isPublic) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.searchParams.set("next", path);
    return NextResponse.redirect(redirectUrl);
  }

  // Already signed in and sitting on /login — send them into the app.
  if (userId && path.startsWith("/login")) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/";
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  return NextResponse.next({ request });
}

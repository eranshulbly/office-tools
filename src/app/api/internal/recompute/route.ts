import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { callRpc } from "@/lib/db/rpc";

/**
 * Rebuild attendance for a date range. Called by the attendance gateway after
 * it inserts punches, so the grid updates without an admin pressing anything.
 *
 * recompute_attendance used to be a Postgres function the gateway could call
 * directly. It is now TypeScript inside this app, and the gateway is a separate
 * Node process — hence this endpoint.
 *
 * NOT a user route. It authenticates with a shared secret rather than a
 * session, and nginx never proxies /api/internal, so it is only reachable from
 * localhost on the box itself.
 */
function authorised(req: Request): boolean {
  const expected = process.env.GATEWAY_SHARED_SECRET ?? "";
  if (!expected) return false; // unset means disabled, not open
  const got = req.headers.get("x-gateway-secret") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  // Constant-time so the secret can't be guessed byte by byte.
  return a.length === b.length && timingSafeEqual(a, b);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(req: Request) {
  if (!authorised(req)) return new NextResponse("Forbidden", { status: 403 });

  let body: { from?: string; to?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const from = String(body.from ?? "");
  const to = String(body.to ?? from);
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    return NextResponse.json({ error: "from/to must be YYYY-MM-DD" }, { status: 400 });
  }

  try {
    // userId null — a trusted system caller, matching the original function's
    // `auth.uid() is null` escape hatch for server-side callers.
    await callRpc("recompute_attendance", { from_date: from, to_date: to }, null);
    return NextResponse.json({ ok: true, from, to });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

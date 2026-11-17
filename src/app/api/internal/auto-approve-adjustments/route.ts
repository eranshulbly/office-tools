import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { query } from "@/lib/db/pool";
import { callRpc } from "@/lib/db/rpc";
import { AUTO_APPROVE_DELAY_MINUTES, AUTO_APPROVE_REASON } from "@/lib/adjustments";

/**
 * Approve the adjustments that do not need a human.
 *
 * A "new employee" request exists because somebody's finger is not enrolled on
 * the terminal yet, so they physically cannot punch. There is no judgement for
 * an admin to apply — refusing it would just mark a working day absent — and
 * making an admin click through a queue of them is busywork.
 *
 * Run from cron rather than from a timer inside the app: Next.js gives no
 * durable scheduler, a setInterval would die on every redeploy, and attaching
 * the sweep to request traffic would mean nothing approves overnight.
 *
 * Approval goes through decide_adjustment, NOT a direct UPDATE — that RPC is
 * what refuses days inside a closed payroll run and what rebuilds attendance
 * for the day afterwards. Writing the row by hand would skip both.
 *
 * NOT a user route. Shared-secret auth, and nginx never proxies /api/internal,
 * so it is reachable only from the box itself.
 */
function authorised(req: Request): boolean {
  const expected = process.env.GATEWAY_SHARED_SECRET ?? "";
  if (!expected) return false; // unset means disabled, not open
  const got = req.headers.get("x-gateway-secret") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Row = { id: string; day: string };

export async function POST(req: Request) {
  if (!authorised(req)) return new NextResponse("Forbidden", { status: 403 });

  // Only this reason, only still-pending, and only once the delay has elapsed.
  // requested_at is UTC, as is UTC_TIMESTAMP() — no timezone arithmetic here.
  const due = await query<Row>(
    `SELECT id, day FROM adjustments
      WHERE status = 'pending'
        AND reason = ?
        AND requested_at <= UTC_TIMESTAMP() - INTERVAL ? MINUTE
      ORDER BY requested_at
      LIMIT 200`,
    [AUTO_APPROVE_REASON, AUTO_APPROVE_DELAY_MINUTES]
  );

  const approved: string[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const r of due) {
    try {
      // userId null = trusted server-side caller, the same escape hatch the
      // original Postgres functions kept for `auth.uid() is null`.
      //
      // p_reason stays null on purpose: an approval carries no comment, and
      // the manager's list shows a decision only for REJECTED rows. Writing
      // "auto-approved" here would put the mechanism on their screen.
      await callRpc(
        "decide_adjustment",
        { p_id: r.id, p_approve: true, p_reason: null, p_auto: true },
        null
      );
      approved.push(r.id);
    } catch (e) {
      // One bad row (a day that fell inside a closed payroll run, say) must not
      // stop the rest of the sweep. It stays pending for an admin to handle.
      failed.push({ id: r.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (failed.length) {
    console.error(`[auto-approve] ${failed.length} failed:`, JSON.stringify(failed));
  }

  return NextResponse.json({
    ok: true,
    considered: due.length,
    approved: approved.length,
    failed: failed.length,
  });
}

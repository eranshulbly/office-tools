/**
 * The fixed set of reasons a forgot-punch adjustment can be raised under.
 *
 * Free text was replaced by a closed list so the reason is a fact the system
 * can act on rather than a sentence someone has to read. One of them —
 * "new employee" — is approved automatically a short while after it is raised,
 * because a person whose finger is not enrolled yet cannot punch and an admin
 * rejecting that would be theatre.
 *
 * NOTHING in the manager-facing UI distinguishes the two options, and nothing
 * in the request list reveals that one of them self-approves. A manager who
 * knew would simply pick it every time. The auto-approval is visible only in
 * audit_log, which is admin-only — see AUTO_APPROVE_AUDIT_ACTION.
 */

export const ADJUSTMENT_REASONS = [
  "fingerprint didn't work",
  "new employee",
] as const;

export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

/** The reason that self-approves. Deliberately not referenced in any UI copy. */
export const AUTO_APPROVE_REASON: AdjustmentReason = "new employee";

/**
 * How long a self-approving request waits first.
 *
 * Not zero, for two reasons: an instant approval would be an obvious tell, and
 * the delay leaves an admin a window to reject something that looks wrong
 * before it lands in attendance.
 */
export const AUTO_APPROVE_DELAY_MINUTES = 10;

/** audit_log action for a self-approval, so admins can still spot a pattern. */
export const AUTO_APPROVE_AUDIT_ACTION = "adjustment_auto_approved";

export function isAdjustmentReason(v: string): v is AdjustmentReason {
  return (ADJUSTMENT_REASONS as readonly string[]).includes(v);
}

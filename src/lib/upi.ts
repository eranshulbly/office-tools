/**
 * UPI helpers. `extractVpa` pulls the VPA (UPI id, e.g. "9027705441@axl") out of
 * an HDFC statement narration like "UPI-<acct>-<vpa>-<ref>-<remark>". The VPA may
 * itself contain a hyphen (e.g. "pragatimishra716-1@okaxis"), so we drop the
 * "UPI-" prefix and the first (account) field, then take everything up to the
 * "@<handle>". Returns null for non-UPI narrations (IB FUNDS, IMPS, etc.).
 */
export function extractVpa(narration: string | null | undefined): string | null {
  const s = (narration ?? "").trim();
  if (!/^UPI/i.test(s)) return null;
  const rest = s.replace(/^UPI-/i, "").replace(/^[^-]*-/, "");
  const m = rest.match(/^(.+?@[A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

/**
 * The payer's bank account number — the field between "UPI-" and the VPA.
 * HDFC masks the VPA since 14 Oct 2026 ("******3148@PTAXIS") but still prints
 * this in full, and it stays the same when a dealer switches UPI apps, so it is
 * the most reliable way to recognise a payer. Null when absent or junk (all 0s).
 */
export function extractPayerAccount(narration: string | null | undefined): string | null {
  const s = (narration ?? "").trim();
  if (!/^UPI-/i.test(s)) return null;
  const acct = s.replace(/^UPI-/i, "").split("-")[0].trim();
  return isValidPayerAccount(acct) ? acct : null;
}

export function isValidPayerAccount(s: string | null | undefined): boolean {
  const t = (s ?? "").trim();
  return /^[0-9A-Za-z]{6,}$/.test(t) && !/^0+$/.test(t);
}

/** True for a bank-masked VPA such as "******3148@ptaxis". */
export function isMaskedVpa(vpa: string | null | undefined): boolean {
  return (vpa ?? "").includes("*");
}

/** Normalise a UPI id for matching (trim + lowercase). */
export function normUpi(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/** The firms UPI mappings and reconciliation belong to (same as our cheque payees). */
export const FIRMS = ["Anmol Associates", "Om Marketing"] as const;
export type Firm = (typeof FIRMS)[number];
export const DEFAULT_FIRM: Firm = FIRMS[0];

/** Coerce an arbitrary string to a known firm, defaulting to the first. */
export function normFirm(s: string | null | undefined): Firm {
  const t = (s ?? "").trim();
  return (FIRMS as readonly string[]).includes(t) ? (t as Firm) : DEFAULT_FIRM;
}

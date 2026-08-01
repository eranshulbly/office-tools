import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { payeeKey } from "@/lib/cheque";

/**
 * Firm scoping for the cheque suite.
 *
 * A "firm" is not a table — it is the distinct `payee` on an active company
 * bank account. That is deliberate: a firm exists precisely because you bank
 * for it, so adding one is adding a bank account, with no code change and no
 * list to keep in sync. It also replaces the hardcoded FIRMS constant in
 * src/lib/upi.ts, which could drift from reality.
 *
 * Selection lives in an httpOnly cookie rather than the URL. Every tab in the
 * suite then reads the same value with no link rewriting, and a stray or
 * bookmarked link cannot drop someone into the wrong firm's books.
 */

const COOKIE = "cheque_firm";

export type Firm = {
  /** Display name, exactly as stored on the bank account. */
  name: string;
  /** Normalised key for comparison — case- and punctuation-insensitive. */
  key: string;
};

/** Firms, derived from active bank accounts. Sorted for a stable tile order. */
export async function listFirms(): Promise<Firm[]> {
  const db = await createSupabaseServerClient();
  const { data } = await db
    .from("company_bank_accounts")
    .select("payee")
    .eq("is_active", true);

  const seen = new Map<string, string>();
  for (const row of (data ?? []) as { payee: string | null }[]) {
    const name = (row.payee ?? "").trim();
    if (!name) continue;
    const key = payeeKey(name);
    if (!seen.has(key)) seen.set(key, name);
  }
  return [...seen.entries()]
    .map(([key, name]) => ({ key, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The selected firm, or null. Validated against the live list, so a firm that
 *  is renamed or deactivated cannot linger in a stale cookie. */
export async function getActiveFirm(): Promise<Firm | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (!raw) return null;
  const firms = await listFirms();
  return firms.find((f) => f.key === payeeKey(raw)) ?? null;
}

/** Where firm selection lives. Single source so every redirect agrees. */
export const FIRM_PICKER_PATH = "/cheques/firms";

/** The selected firm, or bounce to the picker. Use at the top of every page. */
export async function requireFirm(): Promise<Firm> {
  const firm = await getActiveFirm();
  if (!firm) redirect(FIRM_PICKER_PATH);
  return firm;
}

export const firmCookie = {
  name: COOKIE,
  options: {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 180, // half a year; it is a preference, not a secret
  },
};

/**
 * Does this payee belong to the selected firm?
 *
 * True when it matches the firm, and ALSO true when it matches no known firm at
 * all. That second case is deliberate: a blank or mistyped payee (an AI
 * extraction slip, say) would otherwise be invisible in every firm's view, and
 * a cheque quietly disappearing from the books is far worse than one showing up
 * in the wrong place. Such rows are surfaced with a warning — see isUnfiled.
 */
export function belongsToFirm(
  payee: string | null | undefined,
  firm: Firm,
  allFirms: Firm[]
): boolean {
  const k = payeeKey(payee);
  if (k === firm.key) return true;
  return !allFirms.some((f) => f.key === k);
}

/** A payee that matches no configured firm — shown everywhere, flagged. */
export function isUnfiled(payee: string | null | undefined, allFirms: Firm[]): boolean {
  const k = payeeKey(payee);
  return !allFirms.some((f) => f.key === k);
}

/**
 * Filter any payee-bearing rows to the selected firm.
 *
 * Applied in TypeScript rather than SQL because the comparison is on the
 * normalised key, which has no index and no clean MySQL equivalent. Fine at
 * this scale (a few hundred cheques, already fetched whole); if the table grows
 * to tens of thousands, store the firm key on the row and filter in SQL.
 */
export function scopeToFirm<T extends Record<string, unknown>>(
  rows: T[],
  payeeField: keyof T,
  firm: Firm,
  allFirms: Firm[]
): T[] {
  return rows.filter((r) => belongsToFirm(r[payeeField] as string | null, firm, allFirms));
}

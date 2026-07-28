import type { ChequeStatus } from "@/lib/types";

/** Display label + badge tone for each cheque status (single source of truth). */
export const CHEQUE_STATUS_META: Record<
  ChequeStatus,
  { label: string; tone: "neutral" | "ok" | "warn" | "danger" | "info" }
> = {
  draft: { label: "Draft", tone: "neutral" },
  pending: { label: "Pending approval", tone: "warn" }, // legacy; no longer produced
  rejected: { label: "Rejected", tone: "danger" }, // legacy; no longer produced
  submitted: { label: "Submitted", tone: "info" },
  presented: { label: "Presented to bank", tone: "info" },
  passed: { label: "Passed", tone: "ok" },
  bounced: { label: "Bounced", tone: "danger" },
};

/** Statuses considered "outstanding" (money not yet settled either way). */
export const OUTSTANDING_STATUSES: ChequeStatus[] = ["submitted", "presented"];

/** The two companies a dealer cheque is ever payable to (our own companies). */
export const CHEQUE_PAYEES = ["Anmol Associates", "Om Marketing"] as const;

/** Normalised key for matching a payee name across case/spacing/extra words. */
export function payeeKey(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Identity keys for a physical cheque leaf: bank (IFSC and/or MICR) + account
 * number + cheque number. A cheque is unique on this combination — cheque
 * numbers alone repeat across accounts, so number + account (qualified by the
 * bank) is what actually identifies one leaf.
 *
 * Returns one key per available bank id, so a scan that read the IFSC still
 * matches one that read only the MICR. Empty when the cheque lacks the fields
 * needed to identify it (no cheque number, no account, or no bank id) — such a
 * cheque simply can't be de-duplicated.
 */
export function chequeIdentityKeys(f: {
  cheque_number?: string | null;
  account_number?: string | null;
  ifsc?: string | null;
  micr_code?: string | null;
}): string[] {
  const chq = String(f.cheque_number ?? "").replace(/\D/g, "").replace(/^0+/, "");
  const acct = String(f.account_number ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (!chq || !acct) return [];
  const ifsc = String(f.ifsc ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const micr = String(f.micr_code ?? "").replace(/\D/g, "");
  const keys: string[] = [];
  if (ifsc) keys.push(`I:${ifsc}|${acct}|${chq}`);
  if (micr) keys.push(`M:${micr}|${acct}|${chq}`);
  return keys;
}

// ── Amount → words (Indian numbering: crore / lakh / thousand) ────────────────
const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoWords(n: number): string {
  if (n < 20) return ONES[n];
  return (TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "")).trim();
}
function threeWords(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? ONES[h] + " Hundred" : "", twoWords(r)].filter(Boolean).join(" ").trim();
}

/**
 * Rupee amount in words, Indian style, e.g. 16831 → "Sixteen Thousand Eight
 * Hundred Thirty One Only". Handles paise. Returns "" for empty/invalid.
 */
export function amountToWords(amount: number | string | null | undefined): string {
  const num = typeof amount === "string" ? parseFloat(amount.replace(/,/g, "")) : amount ?? NaN;
  if (!Number.isFinite(num) || num < 0) return "";
  const rupees = Math.floor(num);
  const paise = Math.round((num - rupees) * 100);
  if (rupees === 0 && paise === 0) return "";

  const parts: string[] = [];
  let r = rupees;
  const crore = Math.floor(r / 10000000); r %= 10000000;
  const lakh = Math.floor(r / 100000); r %= 100000;
  const thousand = Math.floor(r / 1000); r %= 1000;
  if (crore) parts.push(twoWords(crore) + " Crore");
  if (lakh) parts.push(twoWords(lakh) + " Lakh");
  if (thousand) parts.push(twoWords(thousand) + " Thousand");
  if (r) parts.push(threeWords(r));

  let words = parts.join(" ").trim();
  if (rupees > 0 && paise > 0) words += " and " + twoWords(paise) + " Paise";
  else if (rupees === 0 && paise > 0) words = twoWords(paise) + " Paise";
  return words ? words + " Only" : "";
}

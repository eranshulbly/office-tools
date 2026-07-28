import type { ChequeFields } from "@/lib/types";

/** Shared field layout for cheque entry + inline edit. `req` = needed to submit. */
export const CHEQUE_FIELD_DEFS: {
  name: keyof ChequeFields;
  label: string;
  type?: string;
  req?: boolean;
  wide?: boolean;
}[] = [
  { name: "cheque_number", label: "Cheque no.", req: true },
  { name: "amount", label: "Amount (₹)", type: "number", req: true },
  { name: "cheque_date", label: "Cheque date", type: "date" },
  { name: "received_date", label: "Received on", type: "date" },
  { name: "dealer_name", label: "Dealer name", req: true },
  { name: "bank_name", label: "Drawee bank" },
  { name: "branch", label: "Branch" },
  { name: "ifsc", label: "IFSC" },
  { name: "account_number", label: "Account no." },
  { name: "micr_code", label: "MICR" },
  { name: "payee_name", label: "Payee name" },
  { name: "amount_in_words", label: "Amount in words", wide: true },
  { name: "notes", label: "Notes", wide: true },
];

export function chequeMissingRequired(f: ChequeFields): boolean {
  return (
    !String(f.cheque_number ?? "").trim() ||
    !(Number(f.amount) > 0) ||
    !String(f.dealer_name ?? "").trim()
  );
}

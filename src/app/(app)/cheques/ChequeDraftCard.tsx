"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Card, FormError } from "@/components/ui";
import type { Cheque, ChequeFields } from "@/lib/types";
import { CHEQUE_STATUS_META, amountToWords } from "@/lib/cheque";
import { CHEQUE_FIELD_DEFS as FIELDS, chequeMissingRequired } from "./fields";
import { updateChequeDraft, submitCheque } from "./actions";

const inputClass = "mt-0.5 w-full rounded border border-line px-2.5 py-1.5 text-sm";
const labelClass = "text-xs font-medium text-muted";
const BTN_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_PRIMARY = `${BTN_BASE} bg-[var(--color-brand)] text-white border-transparent shadow-[var(--shadow-sm)] hover:bg-[var(--color-brand-strong)]`;
const BTN_DEFAULT = `${BTN_BASE} bg-surface text-ink border-line hover:bg-[var(--color-surface-2)] hover:border-line-strong`;

function toFields(c: Cheque): ChequeFields {
  return {
    cheque_number: c.cheque_number ?? "",
    amount: c.amount != null ? String(c.amount) : "",
    cheque_date: c.cheque_date ?? "",
    received_date: c.received_date ?? "",
    dealer_name: c.dealer_name ?? "",
    bank_name: c.bank_name ?? "",
    branch: c.branch ?? "",
    ifsc: c.ifsc ?? "",
    account_number: c.account_number ?? "",
    micr_code: c.micr_code ?? "",
    payee_name: c.payee_name ?? "",
    amount_in_words: c.amount_in_words ?? "",
    notes: c.notes ?? "",
  };
}

/** One editable draft/rejected cheque: edit fields, save, then submit for approval. */
export function ChequeDraftCard({ cheque }: { cheque: Cheque }) {
  const router = useRouter();
  const [fields, setFields] = useState<ChequeFields>(toFields(cheque));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const meta = CHEQUE_STATUS_META[cheque.status];

  const set = (name: keyof ChequeFields, value: string) =>
    setFields((f) => {
      const next = { ...f, [name]: value };
      if (name === "amount") next.amount_in_words = amountToWords(value);
      return next;
    });

  const doSave = async (): Promise<boolean> => {
    const res = await updateChequeDraft(cheque.id, fields);
    if (res.error) { setError(res.error); return false; }
    return true;
  };

  const onSave = async () => {
    setError(undefined); setBusy(true);
    const ok = await doSave();
    setBusy(false);
    if (ok) router.refresh();
  };

  const onSubmit = async () => {
    setError(undefined);
    if (chequeMissingRequired(fields)) {
      setError("Cheque number, a positive amount, and dealer name are required before submitting.");
      return;
    }
    setBusy(true);
    if (!(await doSave())) { setBusy(false); return; }
    const res = await submitCheque(cheque.id);
    setBusy(false);
    if (res.error) { setError(res.error); return; }
    router.refresh();
  };

  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        {cheque.status === "rejected" && cheque.decision_reason && (
          <span className="text-xs text-[var(--color-danger)]">Reason: {cheque.decision_reason}</span>
        )}
      </div>
      <FormError message={error} />
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
        {FIELDS.map((f) => (
          <label key={f.name} className={f.wide ? "col-span-2 sm:col-span-3" : ""}>
            <span className={labelClass}>
              {f.label}
              {f.req && <span className="text-[var(--color-danger)]"> *</span>}
            </span>
            <input
              type={f.type ?? "text"}
              step={f.type === "number" ? "0.01" : undefined}
              value={fields[f.name] ?? ""}
              onChange={(e) => set(f.name, e.target.value)}
              className={inputClass}
            />
          </label>
        ))}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className={BTN_DEFAULT} onClick={onSave} disabled={busy}>
          {busy ? "Working…" : "Save"}
        </button>
        <button type="button" className={BTN_PRIMARY} onClick={onSubmit} disabled={busy}>
          Submit
        </button>
      </div>
    </Card>
  );
}

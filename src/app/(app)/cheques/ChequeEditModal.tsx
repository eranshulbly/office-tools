"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormError } from "@/components/ui";
import type { ChequeFields } from "@/lib/types";
import { amountToWords } from "@/lib/cheque";
import { CHEQUE_FIELD_DEFS as FIELDS } from "./fields";
import { adminUpdateCheque } from "./actions";

const inputClass = "mt-0.5 w-full rounded border border-line px-2.5 py-1.5 text-sm";
const labelClass = "text-xs font-medium text-muted";
const BTN_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_PRIMARY = `${BTN_BASE} bg-[var(--color-brand)] text-white border-transparent shadow-[var(--shadow-sm)] hover:bg-[var(--color-brand-strong)]`;
const BTN_DEFAULT = `${BTN_BASE} bg-surface text-ink border-line hover:bg-[var(--color-surface-2)] hover:border-line-strong`;

/**
 * Admin modal to fix any editable field on a cheque from reconciliation.
 * Editing the amount auto-rewrites "amount in words".
 */
export function ChequeEditModal({
  id,
  initial,
  onClose,
}: {
  id: string;
  initial: ChequeFields;
  onClose: () => void;
}) {
  const router = useRouter();
  const [fields, setFields] = useState<ChequeFields>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const set = (name: keyof ChequeFields, value: string) =>
    setFields((f) => {
      const next = { ...f, [name]: value };
      if (name === "amount") next.amount_in_words = amountToWords(value);
      return next;
    });

  const onSave = async () => {
    setError(undefined);
    setBusy(true);
    const res = await adminUpdateCheque(id, fields);
    setBusy(false);
    if (res.error) { setError(res.error); return; }
    router.refresh();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[85vh] overflow-auto rounded-xl border border-line bg-surface p-5 shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-ink">Edit cheque</h3>
          <button type="button" onClick={onClose} className="text-muted hover:text-ink" aria-label="Close">✕</button>
        </div>
        <FormError message={error} />
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
          {FIELDS.map((f) => (
            <label key={f.name} className={f.wide ? "col-span-2 sm:col-span-3" : ""}>
              <span className={labelClass}>{f.label}</span>
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
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={BTN_DEFAULT} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={BTN_PRIMARY} onClick={onSave} disabled={busy}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

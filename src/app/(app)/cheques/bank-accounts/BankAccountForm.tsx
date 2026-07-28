"use client";

import { useActionState, useEffect, useRef } from "react";
import { Button, FormError, FormOk } from "@/components/ui";
import { CHEQUE_PAYEES } from "@/lib/cheque";
import { saveBankAccount, type ChequeActionState } from "../actions";

const inputClass = "mt-0.5 w-full rounded border border-line px-2.5 py-1.5 text-sm";
const labelClass = "text-xs font-medium text-muted";

/** Add one of our own bank accounts (cheques are presented "to" these). */
export function BankAccountForm() {
  const [state, formAction, pending] = useActionState<ChequeActionState, FormData>(saveBankAccount, {});
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => { if (state.ok) ref.current?.reset(); }, [state.ok]);

  return (
    <form ref={ref} action={formAction} className="space-y-3">
      <FormError message={state.error} />
      {state.ok && <FormOk message="Bank account added." />}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label>
          <span className={labelClass}>Label <span className="text-[var(--color-danger)]">*</span></span>
          <input name="label" required placeholder="e.g. HDFC Current – 1234" className={inputClass} />
        </label>
        <label>
          <span className={labelClass}>Payee company</span>
          <select name="payee" defaultValue="" className={inputClass}>
            <option value="">— none —</option>
            {CHEQUE_PAYEES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          <span className={labelClass}>Bank name</span>
          <input name="bank_name" className={inputClass} />
        </label>
        <label>
          <span className={labelClass}>Account number</span>
          <input name="account_number" className={inputClass} />
        </label>
        <label>
          <span className={labelClass}>IFSC</span>
          <input name="ifsc" className={inputClass} />
        </label>
      </div>
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Adding…" : "Add bank account"}
      </Button>
    </form>
  );
}

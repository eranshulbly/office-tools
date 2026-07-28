"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { Button, FormError, FormOk, money } from "@/components/ui";
import { SearchableSelect } from "@/components/SearchableSelect";
import { requestAdvance, type AdvanceFormState } from "./actions";

const inputClass = "mt-1 w-full rounded border border-line px-3 py-2 text-sm";

export type AdvanceWorker = {
  id: string;
  label: string;
  outstanding: number;
  salary: number;
};

const initial: AdvanceFormState = {};

export function AdvanceForm({
  workers,
  capMultiple,
}: {
  workers: AdvanceWorker[];
  capMultiple: number;
}) {
  const [state, formAction, pending] = useActionState(requestAdvance, initial);
  const formRef = useRef<HTMLFormElement>(null);
  const [workerId, setWorkerId] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [resetKey, setResetKey] = useState(0); // bump to remount the employee picker

  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
      setWorkerId("");
      setAmountStr("");
      setResetKey((k) => k + 1);
    }
  }, [state.ok]);

  const selected = useMemo(
    () => workers.find((w) => w.id === workerId) ?? null,
    [workers, workerId]
  );

  const amount = Number(amountStr);
  const validAmount = Number.isFinite(amount) && amount > 0;
  const cap = selected ? selected.salary * capMultiple : 0;
  const wouldMake = selected ? selected.outstanding + (validAmount ? amount : 0) : 0;
  const breaches = selected != null && validAmount && wouldMake > cap;

  return (
    <form ref={formRef} action={formAction} className="space-y-4">
      <FormError message={state.error} />
      {state.ok && <FormOk message="Advance request submitted." />}

      <div>
        <label className="text-sm font-medium text-ink">Employee</label>
        <SearchableSelect
          key={resetKey}
          name="worker_id"
          required
          placeholder="Search employee by name or code…"
          options={workers.map((w) => ({ value: w.id, label: w.label }))}
          onChange={setWorkerId}
          className={inputClass}
        />
      </div>

      {selected && (
        <div className="rounded border border-line bg-gray-50 px-3 py-2 text-sm space-y-1">
          <div>
            Monthly salary: <span className="tabular font-medium">{money(selected.salary)}</span>
          </div>
          <div>
            Outstanding: <span className="tabular font-medium">{money(selected.outstanding)}</span>
          </div>
          <div>
            Cap (salary × {capMultiple}):{" "}
            <span className="tabular font-medium">{money(cap)}</span>
          </div>
          {validAmount && (
            <div className={breaches ? "text-[var(--color-danger)] font-medium" : ""}>
              This request would make{" "}
              <span className="tabular">{money(wouldMake)}</span>
              {breaches ? " — exceeds cap, will be blocked." : "."}
            </div>
          )}
        </div>
      )}

      <div>
        <label className="text-sm font-medium text-ink">Amount</label>
        <input
          type="number"
          name="amount"
          min="0"
          step="0.01"
          required
          value={amountStr}
          onChange={(e) => setAmountStr(e.target.value)}
          className={inputClass}
        />
      </div>

      <div>
        <label className="text-sm font-medium text-ink">Reason (required)</label>
        <textarea name="reason" required rows={3} className={inputClass} />
      </div>

      <Button type="submit" variant="primary" disabled={pending || breaches}>
        {pending ? "Submitting…" : "Request advance"}
      </Button>
      {breaches && (
        <p className="text-[var(--color-danger)] text-xs">
          Reduce the amount to at most {money(cap - selected!.outstanding)} for this employee.
        </p>
      )}
    </form>
  );
}

"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button, FormError, FormOk } from "@/components/ui";
import { SearchableSelect } from "@/components/SearchableSelect";
import { requestAdjustment, type AdjustmentFormState } from "./actions";

const inputClass = "mt-1 w-full rounded-lg border border-line px-3 py-2.5 text-sm";

export type WorkerOption = { id: string; label: string };

const initial: AdjustmentFormState = {};

// Sensible defaults so the form is submittable as-is: today, 9 AM in, 8 PM out.
const DEFAULT_IN_HOUR = "09:00";
const DEFAULT_OUT_HOUR = "20:00";
const DEFAULT_REASON = "Biometric punch missed — manual entry";

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function AdjustmentForm({ workers }: { workers: WorkerOption[] }) {
  const [state, formAction, pending] = useActionState(requestAdjustment, initial);
  const formRef = useRef<HTMLFormElement>(null);

  const initialDay = todayStr();

  const [resetKey, setResetKey] = useState(0); // bump to remount the employee picker
  const [day, setDay] = useState(initialDay);
  const [propIn, setPropIn] = useState(`${initialDay}T${DEFAULT_IN_HOUR}`);
  const [propOut, setPropOut] = useState(`${initialDay}T${DEFAULT_OUT_HOUR}`);
  const [reason, setReason] = useState(DEFAULT_REASON);

  // Changing the Day keeps IN/OUT on that date at the default 9 AM / 8 PM.
  function onDayChange(v: string) {
    setDay(v);
    if (v) {
      setPropIn(`${v}T${DEFAULT_IN_HOUR}`);
      setPropOut(`${v}T${DEFAULT_OUT_HOUR}`);
    }
  }

  // After a successful submit, reset back to the defaults (not blank).
  useEffect(() => {
    if (state.ok) {
      const d = todayStr();
      setResetKey((k) => k + 1);
      setDay(d);
      setPropIn(`${d}T${DEFAULT_IN_HOUR}`);
      setPropOut(`${d}T${DEFAULT_OUT_HOUR}`);
      setReason(DEFAULT_REASON);
    }
  }, [state.ok]);

  return (
    <form ref={formRef} action={formAction} className="space-y-4">
      <FormError message={state.error} />
      {state.ok && <FormOk message="Adjustment request submitted." />}

      <div>
        <label className="text-sm font-medium text-ink">Employee</label>
        <SearchableSelect
          key={resetKey}
          name="worker_id"
          required
          placeholder="Search employee by name or code…"
          options={workers.map((w) => ({ value: w.id, label: w.label }))}
          className={inputClass}
        />
      </div>

      <div>
        <label className="text-sm font-medium text-ink">Day</label>
        <input
          type="date"
          name="day"
          required
          value={day}
          onChange={(e) => onDayChange(e.target.value)}
          className={inputClass}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="text-sm font-medium text-ink">Proposed IN</label>
          <input
            type="datetime-local"
            name="proposed_in"
            value={propIn}
            onChange={(e) => setPropIn(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className="text-sm font-medium text-ink">Proposed OUT</label>
          <input
            type="datetime-local"
            name="proposed_out"
            value={propOut}
            onChange={(e) => setPropOut(e.target.value)}
            className={inputClass}
          />
        </div>
      </div>
      <p className="text-muted text-xs -mt-2">
        Pre-filled to 9:00 AM – 8:00 PM. Adjust any field before submitting.
      </p>

      <div>
        <label className="text-sm font-medium text-ink">Reason (required)</label>
        <textarea
          name="reason"
          required
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={inputClass}
        />
      </div>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Submitting…" : "Request adjustment"}
      </Button>
    </form>
  );
}

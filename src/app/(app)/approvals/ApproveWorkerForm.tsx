"use client";

import { useState, useTransition } from "react";
import { FormError } from "@/components/ui";
import { approveNewWorker, rejectNewWorker } from "./actions";

// Mirrors ui.tsx Button styling (which has no onClick prop, so native buttons
// here). Kept local to avoid touching shared files.
const BTN_BASE =
  "inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_PRIMARY = `${BTN_BASE} bg-[var(--color-brand)] text-white border-transparent hover:bg-[var(--color-brand-strong)]`;
const BTN_DANGER = `${BTN_BASE} bg-[var(--color-danger)] text-white border-transparent hover:opacity-90`;
const BTN_GHOST = `${BTN_BASE} bg-transparent text-brand border-transparent hover:underline`;
const INPUT = "mt-1 w-full rounded border border-line px-3 py-2 text-sm";

/**
 * Admin action for a manager-submitted new worker: enter the confidential
 * monthly salary (required, must be > 0) and optional bank details, then
 * approve & activate. The Reject control reveals a mandatory reason textarea.
 * RPC errors (e.g. salary required) are surfaced verbatim.
 */
export function ApproveWorkerForm({ workerId }: { workerId: string }) {
  const [salary, setSalary] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [bankIfsc, setBankIfsc] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");

  function approve() {
    setError(undefined);
    const salaryNum = Number(salary);
    if (salary.trim() === "" || Number.isNaN(salaryNum)) {
      setError("Monthly salary is required.");
      return;
    }
    startTransition(async () => {
      const res = await approveNewWorker(workerId, salaryNum, bankAccount, bankIfsc);
      if ("error" in res) setError(res.error);
      // On success the server action revalidated /approvals; row drops out.
    });
  }

  function reject() {
    setError(undefined);
    if (reason.trim() === "") {
      setError("A reason is required to reject.");
      return;
    }
    startTransition(async () => {
      const res = await rejectNewWorker(workerId, reason.trim());
      if ("error" in res) setError(res.error);
      else {
        setRejectOpen(false);
        setReason("");
      }
    });
  }

  return (
    <div className="flex flex-col gap-2 min-w-64">
      <label className="text-xs text-muted">
        Monthly salary (₹)
        <input
          type="number"
          min="0"
          step="0.01"
          value={salary}
          onChange={(e) => setSalary(e.target.value)}
          placeholder="Required"
          className={INPUT}
        />
      </label>
      <label className="text-xs text-muted">
        Bank account
        <input
          type="text"
          value={bankAccount}
          onChange={(e) => setBankAccount(e.target.value)}
          placeholder="Optional"
          className={INPUT}
        />
      </label>
      <label className="text-xs text-muted">
        Bank IFSC
        <input
          type="text"
          value={bankIfsc}
          onChange={(e) => setBankIfsc(e.target.value)}
          placeholder="Optional"
          className={INPUT}
        />
      </label>

      <FormError message={error} />

      <div className="flex items-center gap-2">
        <button type="button" className={BTN_PRIMARY} onClick={approve} disabled={pending}>
          {pending ? "Working…" : "Approve & activate"}
        </button>
        {!rejectOpen && (
          <button
            type="button"
            className={BTN_DANGER}
            onClick={() => {
              setRejectOpen(true);
              setError(undefined);
            }}
            disabled={pending}
          >
            Reject
          </button>
        )}
      </div>

      {rejectOpen && (
        <div className="flex flex-col gap-1.5">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for rejection (required)"
            rows={2}
            className={INPUT}
          />
          <div className="flex items-center gap-2">
            <button type="button" className={BTN_DANGER} onClick={reject} disabled={pending}>
              {pending ? "Rejecting…" : "Confirm reject"}
            </button>
            <button
              type="button"
              className={BTN_GHOST}
              onClick={() => {
                setRejectOpen(false);
                setReason("");
                setError(undefined);
              }}
              disabled={pending}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

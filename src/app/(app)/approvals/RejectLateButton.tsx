"use client";

import { useState, useTransition } from "react";
import { FormError } from "@/components/ui";
import { decideLateReview } from "./actions";

const BTN_BASE =
  "inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_DANGER = `${BTN_BASE} bg-[var(--color-danger)] text-white border-transparent hover:opacity-90`;
const BTN_GHOST = `${BTN_BASE} bg-transparent text-brand border-transparent hover:underline`;

/** Reject a held late-arrival day → absent (mandatory reason). */
export function RejectLateButton({ workerId, day }: { workerId: string; day: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(undefined);
    if (reason.trim() === "") {
      setError("A reason is required to reject.");
      return;
    }
    startTransition(async () => {
      const res = await decideLateReview(workerId, day, false, reason.trim());
      if ("error" in res) setError(res.error);
      else {
        setOpen(false);
        setReason("");
      }
    });
  }

  if (!open) {
    return (
      <button type="button" className={BTN_DANGER} onClick={() => setOpen(true)}>
        Reject
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 min-w-56">
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason for rejection (required)"
        rows={2}
        className="mt-1 w-full rounded border border-line px-3 py-2 text-sm"
      />
      <FormError message={error} />
      <div className="flex items-center gap-2">
        <button type="button" className={BTN_DANGER} onClick={submit} disabled={pending}>
          {pending ? "Rejecting…" : "Confirm reject"}
        </button>
        <button
          type="button"
          className={BTN_GHOST}
          onClick={() => {
            setOpen(false);
            setError(undefined);
          }}
          disabled={pending}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { FormError } from "@/components/ui";
import { decideWorkerEdit } from "./actions";

const BTN_BASE =
  "inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_PRIMARY = `${BTN_BASE} bg-[var(--color-brand)] text-white border-transparent hover:bg-[var(--color-brand-strong)]`;
const BTN_DANGER = `${BTN_BASE} bg-[var(--color-danger)] text-white border-transparent hover:opacity-90`;
const BTN_GHOST = `${BTN_BASE} bg-transparent text-brand border-transparent hover:underline`;
const INPUT = "mt-1 w-full rounded border border-line px-3 py-2 text-sm";

/**
 * Approve/reject a manager-proposed worker edit (admin-only RPC). Approve applies
 * the payload; reject reveals a mandatory reason textarea. RPC errors verbatim.
 */
export function DecideEditButtons({ requestId }: { requestId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  function approve() {
    setError(undefined);
    startTransition(async () => {
      const res = await decideWorkerEdit(requestId, true, "");
      if ("error" in res) setError(res.error);
    });
  }

  function reject() {
    setError(undefined);
    if (reason.trim() === "") {
      setError("A reason is required to reject.");
      return;
    }
    startTransition(async () => {
      const res = await decideWorkerEdit(requestId, false, reason.trim());
      if ("error" in res) setError(res.error);
      else {
        setOpen(false);
        setReason("");
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1.5 min-w-56">
      <div className="flex items-center gap-2">
        <button type="button" className={BTN_PRIMARY} onClick={approve} disabled={pending}>
          {pending ? "Working…" : "Approve"}
        </button>
        {!open && (
          <button
            type="button"
            className={BTN_DANGER}
            onClick={() => {
              setOpen(true);
              setError(undefined);
            }}
            disabled={pending}
          >
            Reject
          </button>
        )}
      </div>

      {open && (
        <div className="flex flex-col gap-1.5 w-full">
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
                setOpen(false);
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

      <FormError message={error} />
    </div>
  );
}

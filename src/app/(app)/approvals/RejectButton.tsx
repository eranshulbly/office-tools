"use client";

import { useState, useTransition } from "react";
import { FormError } from "@/components/ui";
import { decideAdjustment, decideAdvance } from "./actions";

// Mirrors the ui.tsx Button styling (which has no onClick prop, so we use a
// native button here). Kept local to avoid touching shared files.
const BTN_BASE =
  "inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_DANGER = `${BTN_BASE} bg-[var(--color-danger)] text-white border-transparent hover:opacity-90`;
const BTN_GHOST = `${BTN_BASE} bg-transparent text-brand border-transparent hover:underline`;

/**
 * Reject control for a pending adjustment or advance. Reveals a mandatory reason
 * textarea, then calls the admin-only decision RPC via a server action. Any RPC
 * error (e.g. "already decided", "closed payroll run") is surfaced verbatim.
 */
export function RejectButton({
  id,
  kind,
}: {
  id: string;
  kind: "adjustment" | "advance";
}) {
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
      const decide = kind === "adjustment" ? decideAdjustment : decideAdvance;
      const res = await decide(id, false, reason.trim());
      if ("error" in res) {
        setError(res.error);
      } else {
        // Server action revalidated /approvals; row drops out on re-render.
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

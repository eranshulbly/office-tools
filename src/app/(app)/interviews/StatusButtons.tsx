"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setCandidateStatus } from "./actions";
import type { CandidateStatus } from "@/lib/types";

const BTN =
  "rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50 whitespace-nowrap";
const OK = `${BTN} border-transparent bg-[var(--color-ok)] text-white hover:opacity-90`;
const NO = `${BTN} border-transparent bg-[var(--color-danger)] text-white hover:opacity-90`;
const PLAIN = `${BTN} border-line bg-surface text-ink hover:bg-[var(--color-surface-2)]`;

export function StatusButtons({
  id,
  status,
}: {
  id: string;
  status: CandidateStatus;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();

  const move = (next: CandidateStatus, why?: string) =>
    start(async () => {
      setError(undefined);
      const res = await setCandidateStatus(id, next, why);
      if (res.error) { setError(res.error); return; }
      setAsking(false);
      setReason("");
      router.refresh();
    });

  // Rejecting asks for a reason inline rather than in a modal — it is one field,
  // and a decision recorded without a reason is useless three months later.
  if (asking) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for rejection"
            className="w-56 rounded-lg border border-line px-2.5 py-1.5 text-xs"
            onKeyDown={(e) => { if (e.key === "Enter" && reason.trim()) move("rejected", reason); }}
          />
          <button type="button" className={NO} disabled={pending || !reason.trim()} onClick={() => move("rejected", reason)}>
            {pending ? "Saving…" : "Confirm reject"}
          </button>
          <button type="button" className={PLAIN} disabled={pending} onClick={() => { setAsking(false); setError(undefined); }}>
            Cancel
          </button>
        </div>
        {error && <span className="text-xs text-[var(--color-danger)]">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {status !== "shortlisted" && (
          <button type="button" className={OK} disabled={pending} onClick={() => move("shortlisted")}>
            {pending ? "Saving…" : "Shortlist"}
          </button>
        )}
        {status !== "rejected" && (
          <button type="button" className={NO} disabled={pending} onClick={() => setAsking(true)}>
            Reject
          </button>
        )}
        {status !== "new" && (
          // A decision made in error should be undoable — this clears it back to
          // New rather than leaving a wrong outcome on someone's record.
          <button type="button" className={PLAIN} disabled={pending} onClick={() => move("new")}>
            Undo
          </button>
        )}
      </div>
      {error && <span className="text-xs text-[var(--color-danger)]">{error}</span>}
    </div>
  );
}

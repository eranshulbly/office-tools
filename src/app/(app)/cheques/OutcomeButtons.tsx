"use client";

import { useState, useTransition } from "react";
import { FormError } from "@/components/ui";
import { markOutcome } from "./actions";

const BTN_BASE =
  "inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_OK = `${BTN_BASE} bg-[var(--color-ok)] text-white border-transparent hover:opacity-90`;
const BTN_DANGER = `${BTN_BASE} bg-[var(--color-danger)] text-white border-transparent hover:opacity-90`;
const BTN_GHOST = `${BTN_BASE} bg-transparent text-brand border-transparent hover:underline`;
const INPUT = "rounded border border-line px-2.5 py-1.5 text-sm";

/** ISO yyyy-mm-dd -> dd/mm/yyyy for display. */
function fmtDate(iso: string): string {
  const m = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/**
 * Mark a presented cheque passed, or bounced (reason required).
 *
 * The chip carries the date the cheque was banked (presented_date, as chosen on
 * the present form) — not today. The settlement date is neither asked for nor
 * shown: the RPC stamps cleared_date itself in the warehouse timezone.
 */
export function OutcomeButtons({
  id,
  presentedDate,
}: {
  id: string;
  presentedDate: string | null;
}) {
  const [mode, setMode] = useState<null | "passed" | "bounced">(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  function commit(passed: boolean) {
    setError(undefined);
    if (!passed && reason.trim() === "") {
      setError("A bounce reason is required.");
      return;
    }
    startTransition(async () => {
      const res = await markOutcome(id, passed, reason.trim());
      if (res.error) setError(res.error);
      else { setMode(null); setReason(""); }
    });
  }

  // "Passed" commits straight away; "Bounced" first asks for a reason, which the
  // RPC requires.
  return (
    <div className="flex flex-col items-start gap-1.5 lg:items-end">
      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
        <span
          title="Date this cheque was presented to the bank"
          className="rounded border border-line bg-[var(--color-surface-2)] px-2.5 py-1.5 text-sm text-muted"
        >
          Presented{" "}
          <span className="tabular">{presentedDate ? fmtDate(presentedDate) : "—"}</span>
        </span>
        <button
          type="button"
          className={BTN_OK}
          onClick={() => commit(true)}
          disabled={pending || mode === "bounced"}
        >
          {pending && mode !== "bounced" ? "Saving…" : "Passed"}
        </button>
        <button
          type="button"
          className={BTN_DANGER}
          onClick={() => setMode("bounced")}
          disabled={pending || mode === "bounced"}
        >
          Bounced
        </button>
      </div>

      {mode === "bounced" && (
        <div className="flex w-full min-w-64 flex-col items-end gap-1.5">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Bounce reason (required)"
            rows={2}
            autoFocus
            className={`${INPUT} w-full`}
          />
          <div className="flex items-center gap-2">
            <button type="button" className={BTN_DANGER} onClick={() => commit(false)} disabled={pending}>
              {pending ? "Saving…" : "Confirm bounced"}
            </button>
            <button
              type="button"
              className={BTN_GHOST}
              onClick={() => { setMode(null); setReason(""); setError(undefined); }}
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

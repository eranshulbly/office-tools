"use client";

import { useState, useTransition } from "react";
import { FormError, FormOk } from "@/components/ui";
import { recomputeAttendance } from "./actions";

/**
 * Recompute control: pick a date range and rebuild attendance_days for it. The
 * underlying RPC is idempotent and safe to re-run — we say so out loud here.
 */
export function Recompute({ defaultDay }: { defaultDay: string }) {
  const [from, setFrom] = useState(defaultDay);
  const [to, setTo] = useState(defaultDay);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run() {
    setMsg(null);
    setErr(null);
    startTransition(async () => {
      const res = await recomputeAttendance(from, to);
      if ("error" in res) setErr(res.error);
      else setMsg(res.message);
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Rebuilds <span className="font-medium">attendance_days</span> from raw punches,
        approved adjustments and the work calendar for the chosen range. It is{" "}
        <span className="font-medium">idempotent and safe</span> — running it again produces
        the exact same result and never edits raw punches.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-sm text-muted">From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="mt-1 w-full rounded border border-line px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-sm text-muted">To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="mt-1 w-full rounded border border-line px-3 py-2 text-sm"
          />
        </label>
        <button
          type="button"
          disabled={pending}
          onClick={run}
          className="inline-flex items-center gap-1.5 rounded border border-transparent bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Recomputing…" : "Recompute"}
        </button>
      </div>
      <FormError message={err ?? undefined} />
      <FormOk message={msg ?? undefined} />
    </div>
  );
}

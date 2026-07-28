"use client";

import { useCallback, useEffect, useState } from "react";
import { getWorkerAttendance, type WorkerAttendance } from "./actions";

const STATUS_LABEL: Record<string, string> = {
  full_day: "Full day",
  absent: "Absent",
  unresolved: "Unresolved",
  not_working_day: "Not working",
  late_review: "Late — review",
};
const STATUS_COLOR: Record<string, string> = {
  full_day: "var(--color-ok)",
  absent: "var(--color-warn)",
  unresolved: "var(--color-danger)",
  not_working_day: "var(--color-faint)",
  late_review: "var(--color-danger)",
};

function monthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function WorkerSummaryButton({
  workerId,
  name,
  code,
}: {
  workerId: string;
  name: string;
  code: string;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<WorkerAttendance | null>(null);

  const load = useCallback(
    async (f: string, t: string) => {
      setLoading(true);
      const res = await getWorkerAttendance(workerId, f, t);
      setData(res);
      setLoading(false);
    },
    [workerId]
  );

  function openModal() {
    setOpen(true);
    load(from, to);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="font-medium text-ink hover:text-[var(--color-brand)] hover:underline text-left"
      >
        {name}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-lg bg-surface rounded-2xl shadow-[var(--shadow-lg)] max-h-[85vh] flex flex-col rise"
            onClick={(e) => e.stopPropagation()}
          >
            {/* header */}
            <div className="flex items-start justify-between gap-3 p-5 border-b border-line">
              <div>
                <div className="text-lg font-semibold text-ink">{name}</div>
                <div className="text-muted text-sm">{code} · attendance summary</div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-muted hover:text-ink text-xl leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {/* range picker */}
            <div className="flex flex-wrap items-end gap-2 p-5 border-b border-line">
              <label className="block">
                <span className="text-xs text-muted">From</span>
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="mt-1 block rounded-lg border border-line px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs text-muted">To</span>
                <input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="mt-1 block rounded-lg border border-line px-3 py-2 text-sm"
                />
              </label>
              <button
                type="button"
                onClick={() => load(from, to)}
                className="rounded-lg bg-[var(--color-brand)] text-white px-3.5 py-2 text-sm font-medium hover:bg-[var(--color-brand-strong)]"
              >
                Apply
              </button>
              <button
                type="button"
                onClick={() => {
                  const f = monthStart();
                  const t = today();
                  setFrom(f);
                  setTo(t);
                  load(f, t);
                }}
                className="rounded-lg border border-line px-3 py-2 text-sm text-muted hover:bg-[var(--color-surface-2)]"
              >
                This month
              </button>
            </div>

            {/* body */}
            <div className="p-5 overflow-y-auto">
              {loading ? (
                <div className="text-muted text-sm py-6 text-center">Loading…</div>
              ) : !data ? null : "error" in data ? (
                <div className="text-[var(--color-danger)] text-sm">{data.error}</div>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-2 mb-4">
                    <Stat label="Present" value={data.summary.present} tone="var(--color-ok)" />
                    <Stat label="Absent" value={data.summary.absent} tone="var(--color-warn)" />
                    <Stat label="Leave units" value={data.summary.leave_units} tone="var(--color-danger)" />
                    <Stat label="Full days" value={data.summary.full_day} />
                    <Stat label="Unresolved" value={data.summary.unresolved} tone="var(--color-danger)" />
                    {data.summary.late_review > 0 && (
                      <Stat
                        label="Late — review"
                        value={data.summary.late_review}
                        tone="var(--color-danger)"
                      />
                    )}
                  </div>

                  {data.rows.length === 0 ? (
                    <div className="text-muted text-sm py-4 text-center border border-dashed border-line rounded-lg">
                      No computed attendance in this range. Run Recompute for these dates.
                    </div>
                  ) : (
                    <div className="border border-line rounded-lg overflow-hidden">
                      <div className="max-h-64 overflow-y-auto divide-y divide-line">
                        {data.rows.map((r) => (
                          <div key={r.day} className="flex items-center justify-between px-3 py-2 text-sm">
                            <span className="tabular text-muted">{r.day}</span>
                            <span className="flex items-center gap-3">
                              {r.worked_hours != null && (
                                <span className="tabular text-muted text-xs">
                                  {Number(r.worked_hours).toFixed(2)}h
                                </span>
                              )}
                              <span
                                className="font-medium"
                                style={{ color: STATUS_COLOR[r.status] ?? "var(--color-ink)" }}
                              >
                                {STATUS_LABEL[r.status] ?? r.status}
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-[var(--color-surface-2)] px-3 py-2.5">
      <div className="text-xl font-semibold tabular" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      <div className="text-xs text-muted mt-0.5">{label}</div>
    </div>
  );
}

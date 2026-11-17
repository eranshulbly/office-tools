"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { utcToWarehouseTime } from "@/lib/attendance-status";
import { setAttendanceTiming, type TimingState } from "./actions";

/**
 * Admin correction of one employee's IN/OUT for one day.
 *
 * Deliberately not a status picker. Present and absent are DERIVED from the
 * times everywhere else in the system, and a second way to set them would let
 * the badge disagree with the hours beside it. Editing the times keeps one
 * source of truth: a full-length span reads Present, a short one reads Absent.
 */

const inputClass =
  "mt-1 block w-full rounded-lg border border-line px-3 py-2 text-sm";

export function EditTimingButton({
  workerId,
  name,
  code,
  day,
  firstIn,
  lastOut,
  fullDayHours,
}: {
  workerId: string;
  name: string;
  code: string;
  day: string;
  firstIn: string | null;
  lastOut: string | null;
  fullDayHours: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<TimingState, FormData>(
    setAttendanceTiming,
    {}
  );
  const [inTime, setInTime] = useState("");
  const [outTime, setOutTime] = useState("");

  // Reset to whatever is on file each time the dialog is opened, so a previous
  // edit that was abandoned does not linger in the inputs.
  function openDialog() {
    setInTime(utcToWarehouseTime(firstIn));
    setOutTime(utcToWarehouseTime(lastOut));
    setOpen(true);
  }

  useEffect(() => {
    if (state.ok) setOpen(false);
  }, [state.ok]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const span =
    inTime && outTime
      ? (Date.parse("1970-01-01T" + outTime + ":00Z") -
          Date.parse("1970-01-01T" + inTime + ":00Z")) /
        3_600_000
      : null;

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="text-brand text-sm hover:underline"
      >
        Edit timing
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md bg-surface rounded-2xl shadow-[var(--shadow-lg)] rise"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 p-5 border-b border-line">
              <div>
                <div className="text-lg font-semibold text-ink">Edit timing</div>
                <div className="text-muted text-sm">
                  {[name, code].filter(Boolean).join(" · ")} · {day}
                </div>
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

            <form
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                startTransition(() => formAction(fd));
              }}
              className="p-5 space-y-4"
            >
              <input type="hidden" name="worker_id" value={workerId} />
              <input type="hidden" name="day" value={day} />

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm">
                  <span className="text-muted">IN</span>
                  <input
                    type="time"
                    name="in_time"
                    value={inTime}
                    onChange={(e) => setInTime(e.target.value)}
                    className={inputClass}
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-muted">OUT</span>
                  <input
                    type="time"
                    name="out_time"
                    value={outTime}
                    onChange={(e) => setOutTime(e.target.value)}
                    className={inputClass}
                  />
                </label>
              </div>

              <p className="text-xs text-faint">
                {span == null ? (
                  <>
                    A full day is {fullDayHours} hours or more. Set both times to fix the day
                    outright; set one to fill in a missed punch. Clearing both hands the day
                    back to the device record.
                  </>
                ) : span >= fullDayHours ? (
                  <>
                    {span.toFixed(2)} hours — this day will read{" "}
                    <span className="text-[var(--color-ok)] font-medium">Present</span>.
                  </>
                ) : (
                  <>
                    {span.toFixed(2)} hours, under the {fullDayHours}-hour full day — this day
                    will read <span className="text-[var(--color-warn)] font-medium">Absent</span>.
                  </>
                )}
              </p>

              <label className="block text-sm">
                <span className="text-muted">Reason</span>
                <input
                  type="text"
                  name="reason"
                  required
                  maxLength={200}
                  placeholder="Forgot to punch out, was on site, …"
                  className={inputClass}
                />
                <span className="mt-1 block text-xs text-faint">
                  Recorded in the audit trail against your name.
                </span>
              </label>

              {state.error && (
                <p className="text-sm text-[var(--color-danger)]">{state.error}</p>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded-lg bg-[var(--color-brand)] text-white px-3.5 py-2 text-sm font-medium hover:bg-[var(--color-brand-strong)] disabled:opacity-60"
                >
                  {pending ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setInTime("");
                    setOutTime("");
                  }}
                  className="rounded-lg border border-line px-3 py-2 text-sm text-muted hover:bg-[var(--color-surface-2)]"
                >
                  Clear both
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CalendarDayType } from "@/lib/types";
import { FormError } from "@/components/ui";
import { setCalendarDay } from "./actions";
import { DAY_TYPE_META, DAY_TYPE_ORDER } from "./meta";

export function DayCell({
  day,
  dayNum,
  dayType,
  note,
  isToday,
}: {
  day: string;
  dayNum: number;
  dayType: CalendarDayType;
  note: string | null;
  isToday: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<CalendarDayType>(dayType);
  const [noteVal, setNoteVal] = useState(note ?? "");
  const [confirmExtra, setConfirmExtra] = useState(false);
  const [swapWith, setSwapWith] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const meta = DAY_TYPE_META[dayType];

  function openEditor() {
    setType(dayType);
    setNoteVal(note ?? "");
    setConfirmExtra(false);
    setSwapWith("");
    setErr(null);
    setOpen(true);
  }

  function save() {
    setErr(null);
    if (type === "extra_working" && !confirmExtra) {
      setErr("You must confirm the extra-pay cost before saving an extra working day.");
      return;
    }
    if (type === "swapped_working" && !swapWith) {
      setErr("Enter the working day being closed in exchange.");
      return;
    }
    startTransition(async () => {
      const res = await setCalendarDay({
        day,
        dayType: type,
        note: noteVal,
        confirmExtra: type === "extra_working" ? confirmExtra : undefined,
        swapWith: type === "swapped_working" ? swapWith : undefined,
      });
      if ("error" in res) {
        setErr(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={openEditor}
        className={`flex h-full min-h-20 w-full flex-col items-start gap-1 rounded border p-2 text-left hover:ring-2 hover:ring-[var(--color-brand)] ${meta.cell}`}
      >
        <span className="flex w-full items-center justify-between">
          <span className={`text-sm font-semibold ${isToday ? "underline" : ""}`}>{dayNum}</span>
          {isToday && <span className="text-[10px] uppercase text-muted">today</span>}
        </span>
        <span className="text-[11px] font-medium">{DAY_TYPE_META[dayType].short}</span>
        {note && <span className="truncate text-[10px] text-muted w-full">{note}</span>}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !pending && setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-md border border-line bg-surface p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-ink">Set day type — {day}</h2>

            <div className="mt-3 space-y-2">
              {DAY_TYPE_ORDER.map((t) => (
                <label
                  key={t}
                  className="flex cursor-pointer items-start gap-2 rounded border border-line p-2"
                >
                  <input
                    type="radio"
                    name="dayType"
                    className="mt-1"
                    checked={type === t}
                    onChange={() => {
                      setType(t);
                      setConfirmExtra(false);
                      setErr(null);
                    }}
                  />
                  <span>
                    <span className="flex items-center gap-2 text-sm font-medium text-ink">
                      <span className={`inline-block h-3 w-3 rounded-sm ${DAY_TYPE_META[t].swatch}`} />
                      {DAY_TYPE_META[t].label}
                    </span>
                  </span>
                </label>
              ))}
            </div>

            {type === "extra_working" && (
              <div className="mt-3 rounded border-2 border-[var(--color-danger)] bg-red-50 p-3">
                <p className="text-sm font-semibold text-[var(--color-danger)]">
                  ⚠ This pays every active employee an extra day.
                </p>
                <p className="mt-1 text-sm text-[var(--color-danger)]">
                  An <span className="font-semibold">extra_working</span> day is a genuine extra day
                  opened (e.g. a Sunday). Every employee who attends earns{" "}
                  <span className="font-semibold">+1 day&apos;s pay</span>. If instead a weekday was
                  closed in exchange, use <span className="font-semibold">Swapped working</span> —
                  that pays nothing extra.
                </p>
                <label className="mt-2 flex items-start gap-2 text-sm font-medium text-[var(--color-danger)]">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={confirmExtra}
                    onChange={(e) => setConfirmExtra(e.target.checked)}
                  />
                  I understand this adds one day&apos;s pay for every employee and confirm it.
                </label>
              </div>
            )}

            {type === "swapped_working" && (
              <div className="mt-3 rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm text-blue-900">
                <p className="font-semibold">A swap changes two days.</p>
                <p className="mt-1">
                  <span className="font-medium">{day}</span> becomes a normal working day (no extra
                  pay), and the working day you pick below is <span className="font-medium">closed</span>{" "}
                  in exchange.
                </p>
                <label className="mt-2 block">
                  <span className="text-xs font-medium">Working day being closed in exchange</span>
                  <input
                    type="date"
                    value={swapWith}
                    onChange={(e) => {
                      setSwapWith(e.target.value);
                      setErr(null);
                    }}
                    className="mt-1 block w-full rounded-lg border border-blue-300 bg-white px-3 py-2 text-sm text-ink"
                  />
                </label>
                {swapWith && (
                  <p className="mt-2 text-xs">
                    Result: <span className="font-medium">{day}</span> → open (working),{" "}
                    <span className="font-medium">{swapWith}</span> → closed.
                  </p>
                )}
              </div>
            )}

            <label className="mt-3 block">
              <span className="text-sm text-muted">Note (optional)</span>
              <input
                type="text"
                value={noteVal}
                onChange={(e) => setNoteVal(e.target.value)}
                className="mt-1 w-full rounded border border-line px-3 py-2 text-sm"
                placeholder="e.g. Diwali — warehouse closed"
              />
            </label>

            <div className="mt-3">
              <FormError message={err ?? undefined} />
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => setOpen(false)}
                className="inline-flex items-center rounded border border-line bg-white px-3 py-1.5 text-sm font-medium text-ink hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  pending ||
                  (type === "extra_working" && !confirmExtra) ||
                  (type === "swapped_working" && !swapWith)
                }
                onClick={save}
                className={`inline-flex items-center rounded border border-transparent px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 ${
                  type === "extra_working"
                    ? "bg-[var(--color-danger)] hover:opacity-90"
                    : "bg-[var(--color-brand)] hover:opacity-90"
                }`}
              >
                {pending
                  ? "Saving…"
                  : type === "extra_working"
                    ? "Confirm extra-pay day"
                    : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

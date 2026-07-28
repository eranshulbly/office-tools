"use client";

import { useEffect, useState } from "react";
import { Badge, money } from "@/components/ui";

type Component = { id: string; code: string; label: string; type: "earning" | "deduction"; amount: string };

function num(v: string | number | null | undefined): number {
  const n = typeof v === "string" ? parseFloat(v) : v ?? 0;
  return Number.isFinite(n) ? (n as number) : 0;
}

/**
 * Renders the line's net as a clickable value; opens a modal with the earning /
 * deduction components. Keeps the breakdown table to ONE row per worker instead
 * of an inline expanding row (which bloated with 100+ employees).
 */
export function LineBreakdownButton({
  name,
  net,
  components,
}: {
  name: string;
  net: string;
  components: Component[];
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const earnings = components.filter((c) => c.type === "earning").reduce((a, c) => a + num(c.amount), 0);
  const deductions = components.filter((c) => c.type === "deduction").reduce((a, c) => a + num(c.amount), 0);
  const computedNet = earnings - deductions;
  const matches = Math.abs(computedNet - num(net)) < 0.005;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="tabular font-semibold text-ink hover:text-[var(--color-brand)] hover:underline"
        title="View breakdown"
      >
        {money(net)}
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
                <div className="text-base font-semibold text-ink">{name}</div>
                <div className="text-muted text-sm">Salary breakdown</div>
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

            <div className="p-5">
              <table className="w-full text-sm">
                <thead className="text-muted text-left text-xs uppercase tracking-wide">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">Component</th>
                    <th className="py-1.5 pr-3 font-medium">Type</th>
                    <th className="py-1.5 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {components.map((c) => (
                    <tr key={c.id}>
                      <td className="py-2 pr-3">{c.label}</td>
                      <td className="py-2 pr-3">
                        <Badge tone={c.type === "earning" ? "ok" : "danger"}>{c.type}</Badge>
                      </td>
                      <td className="py-2 text-right tabular">{money(c.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-line">
                    <td className="pt-2.5 text-muted" colSpan={2}>
                      Earnings {money(earnings)} − Deductions {money(deductions)}
                    </td>
                    <td className="pt-2.5 text-right tabular text-base font-semibold text-ink">
                      {money(net)}
                    </td>
                  </tr>
                </tfoot>
              </table>
              <div className="mt-3 text-xs">
                {matches ? (
                  <span className="text-[var(--color-ok)]">✓ Net matches the sum of components.</span>
                ) : (
                  <span className="text-[var(--color-danger)]">
                    ✗ Sum of components ({money(computedNet)}) does not match stored net.
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

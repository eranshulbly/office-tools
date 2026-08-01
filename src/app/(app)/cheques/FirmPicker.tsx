import { selectFirm } from "./firm-actions";
import { Card, money } from "@/components/ui";
import type { Firm } from "@/lib/firm";

export type FirmTile = {
  firm: Firm;
  outstandingCount: number;
  outstandingAmount: number;
  accounts: number;
  /** Marks the firm currently in use, so returning here shows where you were. */
  isActive?: boolean;
};

/**
 * Firm chooser for the cheque suite.
 *
 * Each tile carries the firm's outstanding position rather than just its name —
 * the number you'd otherwise open the suite to find out, so the choice is
 * informed rather than blind. Server actions, so no client JS is needed.
 */
export function FirmPicker({ tiles }: { tiles: FirmTile[] }) {
  if (tiles.length === 0) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-[var(--color-warn)]">
        <div className="font-medium text-ink mb-0.5">No firms configured</div>
        A firm is the payee on one of your bank accounts. Add a bank account with a
        payee to get started —{" "}
        <a href="/cheques/bank-accounts" className="underline">Manage bank accounts</a>.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {tiles.map(({ firm, outstandingCount, outstandingAmount, accounts, isActive }) => (
        <form key={firm.key} action={selectFirm.bind(null, firm.name, "/cheques")}>
          <button
            type="submit"
            className={`group w-full text-left rounded-2xl border bg-surface p-5 transition-all hover:shadow-[var(--shadow-md)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)] ${
              isActive
                ? "border-[var(--color-brand)] ring-1 ring-[var(--color-brand)]"
                : "border-line hover:border-[var(--color-brand)]"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--color-brand-soft)] text-xl">
                🏢
              </span>
              <span className="text-xs text-muted">
                {isActive && (
                  <span className="mr-2 font-semibold text-[var(--color-brand)]">Current</span>
                )}
                {accounts} account{accounts === 1 ? "" : "s"}
              </span>
            </div>

            <div className="mt-3 text-base font-semibold text-ink group-hover:text-[var(--color-brand)]">
              {firm.name}
            </div>

            <div className="mt-3 border-t border-line pt-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                Outstanding
              </div>
              <div className="mt-0.5 text-lg font-semibold text-ink tabular">
                {money(outstandingAmount)}
              </div>
              <div className="text-xs text-muted">
                {outstandingCount} cheque{outstandingCount === 1 ? "" : "s"}
              </div>
            </div>
          </button>
        </form>
      ))}
    </div>
  );
}

/**
 * Firm indicator shown on every cheque page.
 *
 * Links back to /cheques/firms rather than listing every firm inline: one route
 * to return to means the browser Back button and this link agree, and it does
 * not grow unusable once there are more than a couple of firms.
 */
export function FirmBar({ firm, firms }: { firm: Firm; firms: Firm[] }) {
  return (
    <Card className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
      <a
        href="/cheques/firms"
        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink hover:border-line-strong hover:bg-[var(--color-surface-2)]"
        aria-label="Back to firm selection"
      >
        <span aria-hidden="true">←</span> Change firm
      </a>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Firm</span>
      <span className="text-sm font-semibold text-ink">{firm.name}</span>
      {firms.length > 1 && (
        <span className="ml-auto text-xs text-muted">
          {firms.length} firms configured
        </span>
      )}
    </Card>
  );
}

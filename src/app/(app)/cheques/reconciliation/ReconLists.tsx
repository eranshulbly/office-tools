"use client";

import { useMemo, useState } from "react";
import { Card, Badge, Table, Th, Td, Empty, money } from "@/components/ui";
import { CHEQUE_STATUS_META } from "@/lib/cheque";
import type { ChequeStatus, ChequeFields } from "@/lib/types";
import { type PresentAccount } from "../PresentForm";
import { PresentCard } from "./PresentCard";
import { OutcomeButtons } from "../OutcomeButtons";

export type PresentItem = {
  id: string;
  amount: number | null;
  dealer_name: string | null;
  cheque_number: string | null;
  cheque_date: string | null;
  payee_name: string | null;
  defaultAccountId?: string;
  fields: ChequeFields;
};
export type OutcomeItem = {
  id: string;
  amount: number | null;
  dealer_name: string | null;
  cheque_number: string | null;
  cheque_date: string | null;
  presented_date: string | null;
  notes: string | null;
};
export type SettledItem = {
  id: string;
  status: ChequeStatus;
  cheque_number: string | null;
  dealer_name: string | null;
  payee_name: string | null;
  amount: number | null;
  cheque_date: string | null;
  cleared_date: string | null;
  bounce_reason: string | null;
};

type Tab = "present" | "awaiting" | "settled";

function d(v: string | null): string {
  return v ? new Date(v).toLocaleDateString("en-IN") : "—";
}

/** Build the lowercased search haystack for a cheque (dealer, no., date, amount, …). */
function hay(parts: (string | number | null | undefined)[]): string {
  return parts.filter((p) => p != null && p !== "").join(" ").toLowerCase();
}
function amountForms(a: number | null): string {
  return a != null ? `${a} ${a.toLocaleString("en-IN")}` : "";
}

export function ReconLists({
  present,
  accounts,
  awaiting,
  settled,
  presentDate,
  presentOnly = false,
}: {
  present: PresentItem[];
  accounts: PresentAccount[];
  awaiting: OutcomeItem[];
  settled: SettledItem[];
  presentDate: string;
  /** ops_manager: only the "to present" queue exists — no tab bar, no outcomes. */
  presentOnly?: boolean;
}) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<Tab>("present");
  const [before, setBefore] = useState(""); // cheque_date < this (ISO), blank = off
  const query = q.trim().toLowerCase();

  /**
   * "Dated before" filter — strictly earlier than the chosen day. cheque_date is
   * stored as ISO (yyyy-mm-dd), so a plain string compare is a correct date
   * compare. A cheque with no date can't be shown to fall before the cut-off, so
   * it's excluded while the filter is on (that count is surfaced below the bar).
   */
  const datedBefore = (chequeDate: string | null) =>
    !before || (!!chequeDate && chequeDate.slice(0, 10) < before);

  const fPresent = useMemo(
    () => present.filter((c) => datedBefore(c.cheque_date) && (!query || hay([c.dealer_name, c.cheque_number, c.cheque_date, amountForms(c.amount), c.payee_name]).includes(query))),
    [present, query, before] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const fAwaiting = useMemo(
    () => awaiting.filter((c) => datedBefore(c.cheque_date) && (!query || hay([c.dealer_name, c.cheque_number, c.cheque_date, amountForms(c.amount), c.presented_date]).includes(query))),
    [awaiting, query, before] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const fSettled = useMemo(
    () => settled.filter((c) => datedBefore(c.cheque_date) && (!query || hay([c.dealer_name, c.payee_name, c.cheque_number, c.cheque_date, amountForms(c.amount), c.bounce_reason]).includes(query))),
    [settled, query, before] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const emptyText = (base: string) => (query || before ? "No cheques match your filters." : base);

  // Cheques with a blank cheque date can't be placed against the cut-off, so the
  // filter drops them. Say so rather than letting them disappear unexplained.
  const undatedHidden = useMemo(() => {
    if (!before) return 0;
    const source: { cheque_date: string | null }[] =
      tab === "present" ? present : tab === "awaiting" ? awaiting : settled;
    return source.filter((c) => !c.cheque_date).length;
  }, [before, tab, present, awaiting, settled]);

  // With only one list there is nothing to switch between, so the tab bar is
  // dropped entirely rather than rendered with a single disabled-looking chip.
  const TABS: { key: Tab; label: string; count: number }[] = presentOnly
    ? []
    : [
        { key: "present", label: "To present to bank", count: fPresent.length },
        { key: "awaiting", label: "Presented — awaiting clearance", count: fAwaiting.length },
        { key: "settled", label: "Recently settled", count: fSettled.length },
      ];

  return (
    <>
      {presentOnly && (
        <div className="mb-4 text-sm text-muted">
          {fPresent.length} cheque{fPresent.length === 1 ? "" : "s"} waiting to be presented.
        </div>
      )}

      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-pressed={active}
              className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
                active
                  ? "border-transparent bg-[var(--color-brand)] text-white shadow-[var(--shadow-sm)]"
                  : "border-line bg-surface text-ink hover:border-line-strong hover:bg-[var(--color-surface-2)]"
              }`}
            >
              <span className="text-sm font-semibold leading-tight">{t.label}</span>
              <span
                className={`shrink-0 rounded-full px-2.5 py-0.5 text-sm font-bold tabular ${
                  active ? "bg-white/20 text-white" : "bg-[var(--color-surface-2)] text-muted"
                }`}
              >
                {t.count}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search cheques by dealer, cheque no., date, or amount…"
          className="w-full max-w-md rounded-lg border border-line px-3 py-2 text-sm"
        />
        <label className="flex items-center gap-2 text-sm text-muted">
          Cheque dated before
          <input
            type="date"
            value={before}
            onChange={(e) => setBefore(e.target.value)}
            className="rounded-lg border border-line px-3 py-2 text-sm text-ink"
          />
        </label>
        {before && (
          <button
            type="button"
            onClick={() => setBefore("")}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-[var(--color-surface-2)]"
          >
            Clear date
          </button>
        )}
      </div>

      {undatedHidden > 0 && (
        <div className="mb-4 text-xs text-muted">
          {undatedHidden} cheque{undatedHidden === 1 ? " has" : "s have"} no cheque date recorded and{" "}
          {undatedHidden === 1 ? "is" : "are"} hidden while this date filter is on.
        </div>
      )}

      {tab === "present" && (
        fPresent.length === 0 ? (
          <Empty>{emptyText("No cheques waiting to be presented.")}</Empty>
        ) : (
          <div className="space-y-2">
            {fPresent.map((c) => (
              <PresentCard
                key={c.id}
                item={c}
                accounts={accounts}
                defaultDate={presentDate}
                canEdit={!presentOnly}
              />
            ))}
          </div>
        )
      )}

      {!presentOnly && tab === "awaiting" && (
        fAwaiting.length === 0 ? (
          <Empty>{emptyText("No presented cheques awaiting an outcome.")}</Empty>
        ) : (
          <div className="space-y-2">
            {fAwaiting.map((c) => (
              <Card key={c.id} className="flex flex-col gap-3 p-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0 text-sm lg:flex-1">
                  <div>
                    <span className="font-semibold text-ink tabular">{c.amount != null ? money(c.amount) : "—"}</span>
                    <span className="text-muted">
                      {" "}· {c.dealer_name ?? "—"} · #{c.cheque_number ?? "—"} · dated {d(c.cheque_date)}
                    </span>
                  </div>
                  {c.notes?.trim() && (
                    <div className="mt-1 text-xs text-muted">
                      <span className="font-medium text-ink">Note:</span> {c.notes}
                    </div>
                  )}
                </div>
                <div className="lg:shrink-0">
                  <OutcomeButtons id={c.id} presentedDate={c.presented_date} />
                </div>
              </Card>
            ))}
          </div>
        )
      )}

      {!presentOnly && tab === "settled" && (
        fSettled.length === 0 ? (
          <Empty>{emptyText("Nothing settled yet.")}</Empty>
        ) : (
          <Table
            head={
              <tr>
                <Th>Status</Th>
                <Th>Cheque no.</Th>
                <Th>Dealer</Th>
                <Th>Payee</Th>
                <Th className="text-right">Amount</Th>
                <Th>Cheque date</Th>
                <Th>Settled</Th>
                <Th>Detail</Th>
              </tr>
            }
          >
            {fSettled.map((c) => {
              const meta = CHEQUE_STATUS_META[c.status];
              return (
                <tr key={c.id}>
                  <Td><Badge tone={meta.tone}>{meta.label}</Badge></Td>
                  <Td>{c.cheque_number ?? "—"}</Td>
                  <Td>{c.dealer_name ?? "—"}</Td>
                  <Td className="text-muted">{c.payee_name ?? "—"}</Td>
                  <Td className="text-right tabular">{c.amount != null ? money(c.amount) : "—"}</Td>
                  <Td className="tabular whitespace-nowrap">{d(c.cheque_date)}</Td>
                  <Td>{d(c.cleared_date)}</Td>
                  <Td className="text-muted text-xs">{c.status === "bounced" ? c.bounce_reason ?? "—" : "—"}</Td>
                </tr>
              );
            })}
          </Table>
        )
      )}
    </>
  );
}

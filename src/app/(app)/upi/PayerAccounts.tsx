"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Table, Th, Td, Empty, Badge, FormError } from "@/components/ui";
import type { UpiPayerAccount } from "@/lib/types";
import { deletePayerAccount } from "./actions";

const BTN_OUTLINE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium text-ink hover:bg-[var(--color-surface-2)] disabled:opacity-50";

const SOURCE_LABEL: Record<string, string> = { manual: "Confirmed", statement: "Learned", bulk: "File upload", tally: "Tally" };
const PAGE_SIZE = 20;

/** Payer bank account → dealer, for one firm (already filtered by the caller). */
export function PayerAccounts({ accounts, firm }: { accounts: UpiPayerAccount[]; firm: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return accounts;
    return accounts.filter(
      (a) => a.payer_account.includes(s) || a.dealer_name.toLowerCase().includes(s) || (a.sample_vpa ?? "").toLowerCase().includes(s)
    );
  }, [accounts, q]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  function remove(id: string) {
    setError(undefined);
    start(async () => {
      const res = await deletePayerAccount(id);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
          placeholder="Search account, dealer or UPI ID…"
          className="w-full max-w-xs rounded-lg border border-line px-3 py-2 text-sm"
        />
        <span className="text-sm text-muted">{filtered.length} of {accounts.length} payer accounts</span>
      </div>
      <FormError message={error} />
      {filtered.length === 0 ? (
        <Empty>
          {accounts.length === 0
            ? `No payer accounts saved for ${firm} yet. Confirm matches on the Reconcile tab, or reconcile an older statement and save the accounts it shows.`
            : "No payer accounts match your search."}
        </Empty>
      ) : (
        <>
          <Table
            head={
              <tr>
                <Th>Payer account</Th>
                <Th>Dealer</Th>
                <Th>Seen paying from</Th>
                <Th>Source</Th>
                <Th></Th>
              </tr>
            }
          >
            {pageRows.map((a) => (
              <tr key={a.id}>
                <Td className="tabular">{a.payer_account}</Td>
                <Td className="font-medium text-ink">{a.dealer_name}</Td>
                <Td className="tabular text-muted text-xs">{a.sample_vpa ?? "—"}</Td>
                <Td><Badge tone={a.source === "manual" ? "ok" : "neutral"}>{SOURCE_LABEL[a.source] ?? a.source}</Badge></Td>
                <Td className="text-right">
                  <button
                    type="button"
                    onClick={() => remove(a.id)}
                    disabled={pending}
                    className="text-xs font-medium text-[var(--color-danger)] hover:underline disabled:opacity-50"
                  >
                    Delete
                  </button>
                </Td>
              </tr>
            ))}
          </Table>
          {pageCount > 1 && (
            <div className="mt-3 flex items-center justify-end gap-2">
              <button type="button" className={BTN_OUTLINE} onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1}>
                Previous
              </button>
              <span className="text-sm text-muted">Page {safePage} of {pageCount}</span>
              <button type="button" className={BTN_OUTLINE} onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={safePage >= pageCount}>
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

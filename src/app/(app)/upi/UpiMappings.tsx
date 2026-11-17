"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, Table, Th, Td, Empty, FormError, FormOk } from "@/components/ui";
import type { UpiMapping, UpiPayerAccount } from "@/lib/types";
import { extractVpa, extractPayerAccount, FIRMS, DEFAULT_FIRM, type Firm } from "@/lib/upi";
import { addMapping, deleteMapping, bulkAddMappings } from "./actions";
import { PayerAccounts } from "./PayerAccounts";

const selectClass = "rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink";

const inputClass = "mt-1 w-full rounded border border-line px-3 py-2 text-sm";
const BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-transparent bg-[var(--color-brand)] px-3.5 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-strong)] disabled:opacity-50";
const BTN_OUTLINE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium text-ink hover:bg-[var(--color-surface-2)] disabled:opacity-50";

export function UpiMappings({ mappings, accounts }: { mappings: UpiMapping[]; accounts: UpiPayerAccount[] }) {
  const router = useRouter();
  const [firm, setFirm] = useState<Firm>(DEFAULT_FIRM);
  const [tab, setTab] = useState<"ids" | "accounts">("ids");
  const [upiId, setUpiId] = useState("");
  const [dealer, setDealer] = useState("");
  const [q, setQ] = useState("");
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState<string>();
  const [pending, startTransition] = useTransition();
  const bulkRef = useRef<HTMLInputElement>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string>();
  const [bulkError, setBulkError] = useState<string>();

  async function handleBulk(file: File) {
    setBulkError(undefined);
    setBulkMsg(undefined);
    setBulkBusy(true);
    try {
      const mod = await import("xlsx");
      const XLSX = (mod as unknown as { default?: typeof mod }).default ?? mod;
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: "" });
      // Same shape as the reconcile download: find the Narration + Dealer columns.
      let hi = rows.findIndex((r) => Array.isArray(r) && r.some((c) => String(c).trim().toLowerCase() === "narration"));
      if (hi < 0) hi = 0;
      const header = (rows[hi] as string[]).map((h) => String(h).trim().toLowerCase());
      const iNarr = header.findIndex((h) => h === "narration");
      const iDealer = header.findIndex((h) => h === "dealer");
      if (iNarr < 0 || iDealer < 0) {
        setBulkError('Could not find "Narration" and "Dealer" columns. Upload a reconciliation download with the Dealer column filled in.');
        return;
      }
      // For each row where you filled the Dealer, pull the UPI ID and the payer
      // account out of the narration. Masked UPI IDs are dropped server-side;
      // the account still teaches us who the payer is.
      const pairs: { upi_id: string | null; payer_account: string | null; dealer_name: string }[] = [];
      for (let i = hi + 1; i < rows.length; i++) {
        const r = rows[i] as string[];
        const dealer = String(r[iDealer] ?? "").trim();
        if (!dealer) continue;
        const narration = String(r[iNarr] ?? "");
        const vpa = extractVpa(narration);
        const account = extractPayerAccount(narration);
        if (vpa || account) pairs.push({ upi_id: vpa, payer_account: account, dealer_name: dealer });
      }
      if (pairs.length === 0) {
        setBulkError("No rows with a filled Dealer column (and a UPI narration) were found.");
        return;
      }
      const res = await bulkAddMappings(pairs, firm);
      if (res.error) setBulkError(res.error);
      else {
        const parts = [
          `Added ${res.added ?? 0} new UPI ID mapping${res.added === 1 ? "" : "s"}${res.skipped ? ` (${res.skipped} already mapped)` : ""}`,
          `saved ${res.accounts ?? 0} payer account${res.accounts === 1 ? "" : "s"}`,
        ];
        if (res.conflicts) parts.push(`skipped ${res.conflicts} account${res.conflicts === 1 ? "" : "s"} given two different dealers in the file`);
        setBulkMsg(parts.join(", ") + ".");
        router.refresh();
      }
    } catch (e) {
      setBulkError(`Couldn't read the file: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setBulkBusy(false);
      if (bulkRef.current) bulkRef.current.value = "";
    }
  }

  // Everything on this tab is scoped to the selected firm.
  const firmMappings = useMemo(() => mappings.filter((m) => m.firm === firm), [mappings, firm]);
  const firmAccounts = useMemo(() => accounts.filter((a) => a.firm === firm), [accounts, firm]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return firmMappings;
    return firmMappings.filter(
      (m) => m.upi_id.toLowerCase().includes(s) || m.dealer_name.toLowerCase().includes(s)
    );
  }, [firmMappings, q]);

  // Paginate the table (20 per page) so long lists don't force endless scroll.
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage]
  );

  function add() {
    setError(undefined);
    setOk(undefined);
    startTransition(async () => {
      const res = await addMapping(upiId, dealer, firm);
      if (res.error) setError(res.error);
      else {
        setUpiId("");
        setDealer("");
        setOk("Mapping added.");
        router.refresh();
      }
    });
  }

  function remove(id: string) {
    startTransition(async () => {
      const res = await deleteMapping(id);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-muted">Firm</span>
        <select
          value={firm}
          onChange={(e) => { setFirm(e.target.value as Firm); setPage(1); }}
          className={selectClass}
        >
          {FIRMS.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
        <span className="text-xs text-muted">
          {firmMappings.length} mapping{firmMappings.length === 1 ? "" : "s"} for {firm}
        </span>
      </div>

      <Card className="p-4 max-w-2xl">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="block text-sm">
            <span className="text-muted">UPI ID</span>
            <input
              value={upiId}
              onChange={(e) => setUpiId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="e.g. 9027705441@axl"
              className={inputClass}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Dealer name</span>
            <input
              value={dealer}
              onChange={(e) => setDealer(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="e.g. Sharma Distributors"
              className={inputClass}
            />
          </label>
          <button type="button" className={BTN} onClick={add} disabled={pending}>
            {pending ? "Saving…" : "Add mapping"}
          </button>
        </div>
        <div className="mt-2">
          <FormError message={error} />
          {ok && <FormOk message={ok} />}
        </div>
      </Card>

      <Card className="p-4 max-w-2xl">
        <div className="text-sm font-semibold text-ink">Bulk upload</div>
        <p className="mt-1 text-xs text-muted">
          Upload a reconciliation download (from the Reconcile tab). For every row where you filled the <span className="text-ink">Dealer</span> column,
          the UPI ID and payer account are read from the <span className="text-ink">Narration</span> and saved for that dealer. A UPI ID already
          mapped is left alone; a payer account takes the dealer you entered. The “Potential dealer” column is ignored; copy a
          suggestion into the Dealer column to confirm it.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <input
            ref={bulkRef}
            type="file"
            accept=".xls,.xlsx,.csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleBulk(e.target.files[0])}
          />
          <button type="button" className={BTN_OUTLINE} onClick={() => bulkRef.current?.click()} disabled={bulkBusy}>
            {bulkBusy ? "Importing…" : "Upload file to add mappings"}
          </button>
        </div>
        <div className="mt-2">
          <FormError message={bulkError} />
          {bulkMsg && <FormOk message={bulkMsg} />}
        </div>
      </Card>

      <div className="flex gap-1 border-b border-line">
        {([
          ["ids", `UPI IDs (${firmMappings.length})`],
          ["accounts", `Payer accounts (${firmAccounts.length})`],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === key ? "border-[var(--color-brand)] text-ink" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "accounts" ? (
        <PayerAccounts key={firm} accounts={firmAccounts} firm={firm} />
      ) : (
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <input
            type="search"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
            placeholder="Search UPI ID or dealer…"
            className="w-full max-w-xs rounded-lg border border-line px-3 py-2 text-sm"
          />
          <span className="text-sm text-muted">{filtered.length} of {firmMappings.length} mappings</span>
        </div>
        {filtered.length === 0 ? (
          <Empty>{firmMappings.length === 0 ? `No UPI IDs mapped for ${firm} yet. Add the first above.` : "No mappings match your search."}</Empty>
        ) : (
          <>
            <Table
              head={
                <tr>
                  <Th>UPI ID</Th>
                  <Th>Dealer</Th>
                  <Th></Th>
                </tr>
              }
            >
              {pageRows.map((m) => (
                <tr key={m.id}>
                  <Td className="tabular">{m.upi_id}</Td>
                  <Td className="font-medium text-ink">{m.dealer_name}</Td>
                  <Td className="text-right">
                    <button
                      type="button"
                      onClick={() => remove(m.id)}
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
              <div className="mt-3 flex items-center justify-between gap-2">
                <span className="text-xs text-muted">
                  Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className={BTN_OUTLINE}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={safePage <= 1}
                  >
                    Previous
                  </button>
                  <span className="text-sm text-muted">Page {safePage} of {pageCount}</span>
                  <button
                    type="button"
                    className={BTN_OUTLINE}
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                    disabled={safePage >= pageCount}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      )}
    </div>
  );
}

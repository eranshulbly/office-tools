"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Section, Badge, Table, Th, Td, Empty, money, FormError, FormOk } from "@/components/ui";
import { FIRMS, DEFAULT_FIRM, type Firm } from "@/lib/upi";
import {
  parseLedger,
  matchCheques,
  type SystemCheque,
  type MatchResult,
} from "@/lib/cheque-ledger";
import { applyLedgerSettlements, type LedgerSettlement } from "../actions";

const BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-transparent bg-[var(--color-brand)] px-3.5 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-strong)] disabled:opacity-50";
const BTN_OUTLINE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium text-ink hover:bg-[var(--color-surface-2)] disabled:opacity-50";
const selectClass = "rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink";

async function loadXlsx() {
  const mod = await import("xlsx");
  return (mod as unknown as { default?: typeof mod }).default ?? mod;
}
function d(v: string | null | undefined): string {
  return v ? new Date(v).toLocaleDateString("en-IN") : "—";
}

export function LedgerReconciler({ cheques }: { cheques: SystemCheque[] }) {
  const router = useRouter();
  const [firm, setFirm] = useState<Firm>(DEFAULT_FIRM);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [ledgerStats, setLedgerStats] = useState<{ deposits: number; returns: number } | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState<string>();
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setError(undefined); setOk(undefined); setRows(null); setLedgerStats(null); setExcluded(new Set());
    setBusy(true);
    try {
      const XLSX = await loadXlsx();
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" })
        .map((r) => (r as unknown[]).map((c) => String(c ?? "")));
      const parsed = parseLedger(aoa);
      if (!parsed.ok) { setError(parsed.error ?? "Couldn't read the statement."); return; }
      if (parsed.deposits.length === 0) { setError("No cheque deposits (CHQ DEP rows) found in this statement."); return; }
      setRows(aoa);
      setLedgerStats({ deposits: parsed.deposits.length, returns: parsed.returns.length });
      setFileName(file.name);
    } catch (e) {
      setError(`Couldn't read the file: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // Re-match whenever the statement or firm changes (firm switch re-labels live).
  const results: MatchResult[] | null = useMemo(() => {
    if (!rows) return null;
    return matchCheques(parseLedger(rows), cheques, firm);
  }, [rows, cheques, firm]);

  const toApply = useMemo(() => (results ?? []).filter((r) => r.outcome), [results]);
  const passed = toApply.filter((r) => r.outcome === "passed");
  const bounced = toApply.filter((r) => r.outcome === "bounced");


  const selected = toApply.filter((r) => !excluded.has(r.cheque.id));

  function toggle(id: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function apply() {
    setError(undefined); setOk(undefined);
    if (selected.length === 0) { setError("Nothing selected to apply."); return; }
    setApplying(true);
    const items: LedgerSettlement[] = selected.map((r) => ({
      id: r.cheque.id,
      passed: r.outcome === "passed",
      presentedDate: r.presentedDate ?? null,
      outcomeDate: r.outcomeDate ?? null,
      reason: r.outcome === "bounced" ? r.note : "",
    }));
    const res = await applyLedgerSettlements(items);
    setApplying(false);
    if (res.error) { setError(res.error); return; }
    setOk(`${res.count} cheque${res.count === 1 ? "" : "s"} settled from the ledger.`);
    setRows(null); setLedgerStats(null); setExcluded(new Set());
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-muted">Firm</span>
        <select value={firm} onChange={(e) => setFirm(e.target.value as Firm)} className={selectClass}>
          {FIRMS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <span className="text-xs text-muted">{cheques.length} outstanding cheque{cheques.length === 1 ? "" : "s"} to reconcile</span>
      </div>

      <Card className="p-6 text-center border-2 border-dashed">
        <p className="text-sm text-muted">Upload {firm}&apos;s HDFC account statement (.xls / .xlsx / .csv).</p>
        <div className="mt-3">
          <input
            ref={fileRef}
            type="file"
            accept=".xls,.xlsx,.csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
          <button type="button" className={BTN} onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? "Reading…" : "Choose statement file"}
          </button>
        </div>
        <p className="mt-3 text-xs text-muted">
          Read in your browser — nothing is uploaded. A cheque is settled only on an exact number + amount match. Where the statement
          names the party it must agree with your dealer; where it names no one, the number + amount must identify a single cheque.
        </p>
        <div className="mt-2"><FormError message={error} />{ok && <FormOk message={ok} />}</div>
      </Card>

      {results && ledgerStats && (
        <>
          <Section title={`${fileName}`}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Deposits in ledger" value={`${ledgerStats.deposits}`} />
              <Stat label="Returns in ledger" value={`${ledgerStats.returns}`} tone={ledgerStats.returns ? "warn" : undefined} />
              <Stat label="Will mark passed" value={`${passed.length}`} tone="ok" />
              <Stat label="Will mark bounced" value={`${bounced.length}`} tone={bounced.length ? "danger" : undefined} />
            </div>
          </Section>

          <Section title={`To apply (${toApply.length})`}>
            {toApply.length === 0 ? (
              <Empty>No confident matches — nothing will be changed.</Empty>
            ) : (
              <>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <span className="text-xs text-muted">{selected.length} of {toApply.length} selected</span>
                  <button type="button" className={BTN} onClick={apply} disabled={applying || selected.length === 0}>
                    {applying ? "Applying…" : `Apply ${selected.length} settlement${selected.length === 1 ? "" : "s"}`}
                  </button>
                </div>
                <Table
                  head={
                    <tr>
                      <Th></Th>
                      <Th>Outcome</Th>
                      <Th>Cheque no.</Th>
                      <Th>Dealer</Th>
                      <Th className="text-right">Amount</Th>
                      <Th>Cheque date</Th>
                      <Th>Settled on</Th>
                      <Th>Matched by</Th>
                      <Th>Detail</Th>
                    </tr>
                  }
                >
                  {toApply.map((r) => (
                    <tr key={r.cheque.id}>
                      <Td>
                        <input
                          type="checkbox"
                          checked={!excluded.has(r.cheque.id)}
                          onChange={() => toggle(r.cheque.id)}
                        />
                      </Td>
                      <Td>
                        {r.outcome === "passed"
                          ? <Badge tone="ok">Passed</Badge>
                          : <Badge tone="danger">Bounced</Badge>}
                      </Td>
                      <Td className="tabular">{r.cheque.cheque_number ?? "—"}</Td>
                      <Td className="font-medium text-ink">{r.cheque.dealer_name ?? "—"}</Td>
                      <Td className="text-right tabular">{r.cheque.amount != null ? money(r.cheque.amount) : "—"}</Td>
                      <Td className="tabular whitespace-nowrap">{d(r.cheque.cheque_date)}</Td>
                      <Td className="tabular whitespace-nowrap">{d(r.outcomeDate)}</Td>
                      <Td className="whitespace-nowrap text-xs">
                        {r.nameVerified
                          ? <span className="text-[var(--color-ok)]">No. + amount + party</span>
                          : <span className="text-[var(--color-warn)]">No. + amount only</span>}
                      </Td>
                      <Td className="text-muted text-xs">
                        <span className="block max-w-xs truncate" title={r.note}>{r.note}</span>
                      </Td>
                    </tr>
                  ))}
                </Table>
              </>
            )}
          </Section>

        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "danger" | "warn" }) {
  const color = tone === "ok" ? "text-[var(--color-ok)]" : tone === "danger" ? "text-[var(--color-danger)]" : tone === "warn" ? "text-[var(--color-warn)]" : "text-ink";
  return (
    <Card className="p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular ${color}`}>{value}</div>
    </Card>
  );
}

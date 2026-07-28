"use client";

import { useMemo, useRef, useState } from "react";
import { Card, Section, Badge, Table, Th, Td, Empty, money, FormError } from "@/components/ui";
import { extractVpa, normUpi, FIRMS, DEFAULT_FIRM, type Firm } from "@/lib/upi";

export type Mapping = { upi_id: string; dealer_name: string; review?: string | null; firm: string };

// A parsed statement row, before dealer labelling (labelling depends on the firm).
type ParsedTxn = {
  raw: string[];    // the ORIGINAL row cells, unchanged, for export
  date: string;
  narration: string;
  vpa: string | null;
  credit: number;
  debit: number;
};
type Txn = ParsedTxn & {
  dealer: string | null;          // exact VPA match (confirmed)
  potentialDealer: string | null; // by number/username (suggested, not confirmed)
};

const selectClass = "rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink";

const BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-transparent bg-[var(--color-brand)] px-3.5 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-strong)] disabled:opacity-50";
const BTN_OUTLINE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium text-ink hover:bg-[var(--color-surface-2)]";

const DATE_RE = /^\d{2}\/\d{2}\/\d{2,4}$/;

function amt(v: unknown): number {
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}
async function loadXlsx() {
  const mod = await import("xlsx");
  return (mod as unknown as { default?: typeof mod }).default ?? mod;
}

type View = "all" | "confirmed" | "suggested" | "unmapped" | "credit" | "debit";

export function ReconcileUploader({ mappings }: { mappings: Mapping[] }) {
  const [firm, setFirm] = useState<Firm>(DEFAULT_FIRM);
  const [rows, setRows] = useState<ParsedTxn[] | null>(null);
  const [headerRow, setHeaderRow] = useState<string[]>([]);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("all");
  const fileRef = useRef<HTMLInputElement>(null);

  // Lookup tables built from the SELECTED firm's mappings only.
  // exact VPA lookup + unambiguous number/username lookup (before the @).
  // A mapping with a non-blank `review` (e.g. "Ambiguous - verify") is NOT a
  // confirmed dealer — an exact hit on it is shown as a suggestion instead.
  const { mapByUpi, mapByLocal } = useMemo(() => {
    const byUpi = new Map<string, { dealer: string; confirmed: boolean }>();
    const localDealers = new Map<string, Set<string>>();
    for (const row of mappings) {
      if (row.firm !== firm) continue;
      const key = normUpi(row.upi_id);
      byUpi.set(key, { dealer: row.dealer_name, confirmed: !String(row.review ?? "").trim() });
      const local = key.split("@")[0];
      if (local) {
        const set = localDealers.get(local) ?? new Set<string>();
        set.add(row.dealer_name);
        localDealers.set(local, set);
      }
    }
    const byLocal = new Map<string, string>();
    for (const [local, dealers] of localDealers) if (dealers.size === 1) byLocal.set(local, [...dealers][0]);
    return { mapByUpi: byUpi, mapByLocal: byLocal };
  }, [mappings, firm]);

  // Label each parsed row against the current firm's mappings. Re-runs when the
  // firm changes, so switching firm instantly re-labels the loaded statement.
  const txns: Txn[] | null = useMemo(() => {
    if (!rows) return null;
    return rows.map((t) => {
      let dealer: string | null = null;
      let potentialDealer: string | null = null;
      if (t.vpa) {
        const key = normUpi(t.vpa);
        const hit = mapByUpi.get(key);
        if (hit?.confirmed) dealer = hit.dealer;               // exact, review blank → confirmed
        else if (hit) potentialDealer = hit.dealer;            // exact but flagged → suggested
        else potentialDealer = mapByLocal.get(key.split("@")[0]) ?? null; // by number/username
      }
      return { ...t, dealer, potentialDealer };
    });
  }, [rows, mapByUpi, mapByLocal]);

  async function handleFile(file: File) {
    setError(undefined);
    setBusy(true);
    setRows(null);
    try {
      const XLSX = await loadXlsx();
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" });

      let headerIdx = raw.findIndex(
        (r) => Array.isArray(r) && r.some((c) => String(c).trim().toLowerCase() === "narration")
      );
      if (headerIdx < 0) headerIdx = 0;
      const hdr = ((raw[headerIdx] as unknown[]) ?? []).map((c) => String(c ?? "").trim());

      const out: ParsedTxn[] = [];
      for (let i = headerIdx + 1; i < raw.length; i++) {
        const r = (raw[i] as unknown[]).map((c) => String(c ?? ""));
        const c0 = r[0]?.trim() ?? "";
        const narration = r[1]?.trim() ?? "";
        if (/end of statement/i.test(narration)) break;
        if (!DATE_RE.test(c0)) continue;
        out.push({ raw: r, date: c0, narration, vpa: extractVpa(narration), debit: amt(r[4]), credit: amt(r[5]) });
      }
      if (out.length === 0) setError("No transactions found. Is this an HDFC account statement (.xls/.xlsx)?");
      setHeaderRow(hdr);
      setRows(out);
      setFileName(file.name);
    } catch (e) {
      setError(`Couldn't read the file: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const summary = useMemo(() => {
    if (!txns) return null;
    let credit = 0, debit = 0, confirmed = 0, suggested = 0, unmapped = 0;
    for (const t of txns) {
      credit += t.credit;
      debit += t.debit;
      if (t.dealer) confirmed++;
      else if (t.potentialDealer) suggested++;
      else if (t.vpa) unmapped++;
    }
    return { credit, debit, confirmed, suggested, unmapped };
  }, [txns]);

  const filtered = useMemo(() => {
    if (!txns) return [];
    const s = q.trim().toLowerCase();
    return txns.filter((t) => {
      if (view === "confirmed" && !t.dealer) return false;
      if (view === "suggested" && !t.potentialDealer) return false;
      if (view === "unmapped" && (t.dealer || t.potentialDealer || !t.vpa)) return false;
      if (view === "credit" && !(t.credit > 0)) return false;
      if (view === "debit" && !(t.debit > 0)) return false;
      if (!s) return true;
      return (
        t.narration.toLowerCase().includes(s) ||
        (t.vpa ?? "").toLowerCase().includes(s) ||
        (t.dealer ?? "").toLowerCase().includes(s) ||
        (t.potentialDealer ?? "").toLowerCase().includes(s) ||
        String(t.credit).includes(s) || String(t.debit).includes(s) || t.date.includes(s)
      );
    });
  }, [txns, q, view]);

  async function exportExcel() {
    if (!txns) return;
    const XLSX = await loadXlsx();
    // Keep the original statement columns in their original order; append the two.
    const ncol = headerRow.length;
    const header = [...headerRow, "Dealer", "Potential dealer"];
    const aoa: string[][] = [
      header,
      ...txns.map((t) => {
        const cells = [...t.raw];
        while (cells.length < ncol) cells.push("");
        cells.length = ncol; // trim any overflow so the appended columns line up
        return [...cells, t.dealer ?? "", t.potentialDealer ?? ""];
      }),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Reconciliation");
    const base = fileName.replace(/\.[^.]+$/, "") || "statement";
    const firmSlug = firm.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    XLSX.writeFile(wb, `upi-reconciliation-${firmSlug}-${base}.xlsx`);
  }

  const FILTERS: { key: View; label: string }[] = [
    { key: "all", label: "All" },
    { key: "confirmed", label: "Confirmed" },
    { key: "suggested", label: "Suggested" },
    { key: "unmapped", label: "Unmapped" },
    { key: "credit", label: "Credits" },
    { key: "debit", label: "Debits" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-muted">Firm</span>
        <select value={firm} onChange={(e) => setFirm(e.target.value as Firm)} className={selectClass}>
          {FIRMS.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
        <span className="text-xs text-muted">Transactions are labelled from {firm}&apos;s UPI mappings.</span>
      </div>

      <Card className="p-6 text-center border-2 border-dashed">
        <p className="text-sm text-muted">Upload {firm}&apos;s HDFC account statement (.xls or .xlsx).</p>
        <div className="mt-3">
          <input
            ref={fileRef}
            type="file"
            accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
          <button type="button" className={BTN} onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? "Reading…" : "Choose statement file"}
          </button>
        </div>
        <p className="mt-3 text-xs text-muted">
          Read in your browser — nothing is uploaded. <span className="text-ink">Dealer</span> = exact UPI-ID match;
          <span className="text-ink"> Potential dealer</span> = a suggestion matched by the number/username (needs your confirmation).
        </p>
        <div className="mt-2">
          <FormError message={error} />
        </div>
      </Card>

      {summary && txns && (
        <>
          <Section title={`${fileName} — ${txns.length} transactions`}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat label="Total credited" value={money(summary.credit)} tone="ok" />
              <Stat label="Total debited" value={money(summary.debit)} tone="danger" />
              <Stat label="Confirmed" value={`${summary.confirmed}`} />
              <Stat label="Suggested" value={`${summary.suggested}`} tone={summary.suggested ? "warn" : undefined} />
              <Stat label="Unmapped" value={`${summary.unmapped}`} tone={summary.unmapped ? "warn" : undefined} />
            </div>
          </Section>

          <Section title="Transactions">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setView(f.key)}
                  className={`rounded-full px-3 py-1 text-xs font-medium border ${
                    view === f.key ? "bg-[var(--color-brand)] text-white border-transparent" : "border-line text-muted hover:bg-[var(--color-surface-2)]"
                  }`}
                >
                  {f.label}
                </button>
              ))}
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search dealer, UPI ID, amount, narration…"
                className="ml-auto w-full max-w-xs rounded-lg border border-line px-3 py-1.5 text-sm"
              />
              <button type="button" className={BTN_OUTLINE} onClick={exportExcel}>Download Excel</button>
            </div>
            <div className="text-xs text-muted mb-2">Showing {filtered.length} of {txns.length}</div>
            {filtered.length === 0 ? (
              <Empty>No transactions match.</Empty>
            ) : (
              <Table
                head={
                  <tr>
                    <Th>Date</Th>
                    <Th>UPI ID</Th>
                    <Th>Dealer</Th>
                    <Th>Potential dealer</Th>
                    <Th>Type</Th>
                    <Th className="text-right">Amount</Th>
                    <Th>Narration</Th>
                  </tr>
                }
              >
                {filtered.map((t, i) => (
                  <tr key={i}>
                    <Td className="tabular whitespace-nowrap">{t.date}</Td>
                    <Td className="tabular">{t.vpa ?? "—"}</Td>
                    <Td>{t.dealer ? <span className="font-medium text-ink">{t.dealer}</span> : <span className="text-muted">—</span>}</Td>
                    <Td>{t.potentialDealer ? <span className="text-[var(--color-warn)]">{t.potentialDealer}</span> : <span className="text-muted">—</span>}</Td>
                    <Td>{t.credit > 0 ? <Badge tone="ok">Credit</Badge> : <Badge tone="neutral">Debit</Badge>}</Td>
                    <Td className="tabular text-right">{money(t.credit > 0 ? t.credit : t.debit)}</Td>
                    <Td className="text-muted text-xs">
                      <span className="block max-w-md truncate" title={t.narration}>{t.narration}</span>
                    </Td>
                  </tr>
                ))}
              </Table>
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

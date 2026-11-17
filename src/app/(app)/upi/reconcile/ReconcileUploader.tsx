"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { Card, Section, Badge, Table, Th, Td, Empty, money, FormError, FormOk } from "@/components/ui";
import { extractVpa, extractPayerAccount, isMaskedVpa, FIRMS, DEFAULT_FIRM, type Firm } from "@/lib/upi";
import { buildMatchIndex, matchLine, tierOf, type Match } from "@/lib/upi-match";
import { confirmMatch, saveLearnedAccounts } from "../actions";

export type Mapping = { upi_id: string; dealer_name: string; review?: string | null; alt_dealer?: string | null; firm: string };
export type PayerAccount = { payer_account: string; dealer_name: string; firm: string };

// A parsed statement row, before dealer matching (matching depends on the firm).
type ParsedTxn = {
  raw: string[];    // the ORIGINAL row cells, unchanged, for export
  date: string;
  narration: string;
  vpa: string | null;
  account: string | null;
  credit: number;
  debit: number;
};
type Tier = ReturnType<typeof tierOf>;
type Txn = ParsedTxn & { match: Match; tier: Tier };

const selectClass = "rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink";

const BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-transparent bg-[var(--color-brand)] px-3.5 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-strong)] disabled:opacity-50";
const BTN_OUTLINE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium text-ink hover:bg-[var(--color-surface-2)]";
const BTN_SM =
  "inline-flex items-center justify-center rounded border border-transparent bg-[var(--color-brand)] px-2 py-1 text-xs font-medium text-white hover:bg-[var(--color-brand-strong)] disabled:opacity-50";

const DATE_RE = /^\d{2}\/\d{2}\/\d{2,4}$/;
const DEALER_LIST_ID = "upi-dealer-names";
const MIN_SCORES = [10, 20, 30, 40, 50, 70];

function amt(v: unknown): number {
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}
async function loadXlsx() {
  const mod = await import("xlsx");
  return (mod as unknown as { default?: typeof mod }).default ?? mod;
}

type View = "all" | "confirmed" | "likely" | "possible" | "unmapped" | "credit" | "debit";

export function ReconcileUploader({ mappings, accounts }: { mappings: Mapping[]; accounts: PayerAccount[] }) {
  const [firm, setFirm] = useState<Firm>(DEFAULT_FIRM);
  const [rows, setRows] = useState<ParsedTxn[] | null>(null);
  const [headerRow, setHeaderRow] = useState<string[]>([]);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("all");
  const [minScore, setMinScore] = useState(30);
  // Answers saved during this session, so every row re-matches at once
  // without waiting for a server round-trip.
  const [savedAccounts, setSavedAccounts] = useState<PayerAccount[]>([]);
  const [savedVpas, setSavedVpas] = useState<Mapping[]>([]);
  const [learnMsg, setLearnMsg] = useState<string>();
  const [learnErr, setLearnErr] = useState<string>();
  const [learning, startLearning] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const firmVpas = useMemo(
    () => [...mappings, ...savedVpas].filter((m) => m.firm === firm),
    [mappings, savedVpas, firm]
  );
  const firmAccounts = useMemo(
    () => [...accounts, ...savedAccounts].filter((a) => a.firm === firm),
    [accounts, savedAccounts, firm]
  );

  // Rebuilt when the firm, the statement or any saved answer changes.
  const index = useMemo(() => buildMatchIndex(firmVpas, firmAccounts, rows ?? []), [firmVpas, firmAccounts, rows]);

  const txns: Txn[] | null = useMemo(() => {
    if (!rows) return null;
    return rows.map((t) => {
      const match = matchLine(t, index);
      return { ...t, match, tier: tierOf(match, minScore) };
    });
  }, [rows, index, minScore]);

  // Accounts this statement taught us from cleanly-mapped UPI IDs, not yet saved.
  const learnable = useMemo(() => [...index.learned.values()].filter((l) => !l.flagged), [index]);

  const dealerNames = useMemo(() => {
    const s = new Set<string>();
    for (const m of firmVpas) if (!/^\(.*\)$/.test(m.dealer_name.trim())) s.add(m.dealer_name);
    for (const a of firmAccounts) s.add(a.dealer_name);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [firmVpas, firmAccounts]);

  async function handleFile(file: File) {
    setError(undefined);
    setLearnMsg(undefined);
    setLearnErr(undefined);
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
        out.push({
          raw: r, date: c0, narration,
          vpa: extractVpa(narration), account: extractPayerAccount(narration),
          debit: amt(r[4]), credit: amt(r[5]),
        });
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

  function onConfirmed(dealer: string, account: string | null, vpa: string | null, savedVpa: boolean) {
    if (account) setSavedAccounts((a) => [...a, { payer_account: account, dealer_name: dealer, firm }]);
    if (vpa && savedVpa) setSavedVpas((v) => [...v, { upi_id: vpa, dealer_name: dealer, firm }]);
  }

  function saveLearned() {
    setLearnMsg(undefined);
    setLearnErr(undefined);
    const batch = learnable.map((l) => ({ payer_account: l.payer_account, dealer_name: l.dealer_name, sample_vpa: l.sample_vpa }));
    startLearning(async () => {
      const res = await saveLearnedAccounts(firm, batch);
      if (res.error) return setLearnErr(res.error);
      setSavedAccounts((a) => [...a, ...batch.map((b) => ({ payer_account: b.payer_account, dealer_name: b.dealer_name, firm }))]);
      setLearnMsg(`Saved ${res.added ?? 0} payer account${res.added === 1 ? "" : "s"}${res.skipped ? ` (${res.skipped} already saved)` : ""}.`);
    });
  }

  const summary = useMemo(() => {
    if (!txns) return null;
    let credit = 0, debit = 0, masked = 0;
    const tiers: Record<Tier, number> = { confirmed: 0, likely: 0, possible: 0, unmapped: 0, "not-upi": 0 };
    for (const t of txns) {
      credit += t.credit;
      debit += t.debit;
      tiers[t.tier]++;
      if (isMaskedVpa(t.vpa)) masked++;
    }
    return { credit, debit, masked, ...tiers };
  }, [txns]);

  const filtered = useMemo(() => {
    if (!txns) return [];
    const s = q.trim().toLowerCase();
    return txns.filter((t) => {
      if ((view === "confirmed" || view === "likely" || view === "possible" || view === "unmapped") && t.tier !== view) return false;
      if (view === "credit" && !(t.credit > 0)) return false;
      if (view === "debit" && !(t.debit > 0)) return false;
      if (!s) return true;
      return (
        t.narration.toLowerCase().includes(s) ||
        (t.vpa ?? "").toLowerCase().includes(s) ||
        (t.account ?? "").includes(s) ||
        t.match.candidates.some((c) => c.dealer.toLowerCase().includes(s)) ||
        String(t.credit).includes(s) || String(t.debit).includes(s) || t.date.includes(s)
      );
    });
  }, [txns, q, view]);

  async function exportExcel() {
    if (!txns) return;
    const XLSX = await loadXlsx();
    // Keep the original statement columns in their original order; append ours.
    // "Dealer" holds confirmed matches only — fill it in for the rest and upload
    // the file on the Dealer UPI IDs tab to teach the system.
    const ncol = headerRow.length;
    const header = [...headerRow, "Dealer", "Potential dealer", "Confidence %", "Match reason", "Other candidates", "Payer account"];
    const aoa: string[][] = [
      header,
      ...txns.map((t) => {
        const cells = [...t.raw];
        while (cells.length < ncol) cells.push("");
        cells.length = ncol; // trim any overflow so the appended columns line up
        const m = t.match;
        const suggested = t.tier === "likely" || t.tier === "possible";
        return [
          ...cells,
          t.tier === "confirmed" ? m.dealer ?? "" : "",
          suggested ? m.dealer ?? "" : "",
          t.tier === "confirmed" || suggested ? String(m.score) : "",
          t.tier === "confirmed" || suggested ? m.reason : "",
          suggested ? m.candidates.slice(1, 4).map((c) => `${c.dealer} (${c.score}%)`).join("; ") : "",
          t.account ?? "",
        ];
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
    { key: "likely", label: "Likely" },
    { key: "possible", label: "Possible" },
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
        <span className="text-xs text-muted">Transactions are matched against {firm}&apos;s UPI IDs and payer accounts.</span>
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
          <span className="text-ink">Confirmed</span> = exact UPI ID or a known payer account.{" "}
          <span className="text-ink">Likely / Possible</span> = a scored guess (e.g. a masked ID like ******3148 that fits a dealer&apos;s
          UPI ID) — check it and press Confirm, and that payer is recognised from then on.
        </p>
        <div className="mt-2">
          <FormError message={error} />
        </div>
      </Card>

      {summary && txns && (
        <>
          <Section title={`${fileName} — ${txns.length} transactions${summary.masked ? `, ${summary.masked} with masked UPI IDs` : ""}`}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Total credited" value={money(summary.credit)} tone="ok" />
              <Stat label="Total debited" value={money(summary.debit)} tone="danger" />
              <Stat label="Confirmed" value={`${summary.confirmed}`} />
              <Stat label="Likely (≥70%)" value={`${summary.likely}`} tone={summary.likely ? "warn" : undefined} />
              <Stat label={`Possible (${minScore}–69%)`} value={`${summary.possible}`} tone={summary.possible ? "warn" : undefined} />
              <Stat label="Unmapped" value={`${summary.unmapped}`} tone={summary.unmapped ? "danger" : undefined} />
            </div>
          </Section>

          {learnable.length > 0 && (
            <Card className="p-4">
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm text-ink flex-1 min-w-[16rem]">
                  This statement shows <span className="font-semibold">{learnable.length}</span> payer account
                  {learnable.length === 1 ? "" : "s"} paying from UPI IDs you&apos;ve mapped. Save them so later statements — where the bank
                  hides the UPI ID — match these payers automatically.
                </p>
                <button type="button" className={BTN} onClick={saveLearned} disabled={learning}>
                  {learning ? "Saving…" : `Save ${learnable.length} account${learnable.length === 1 ? "" : "s"}`}
                </button>
              </div>
              <div className="mt-2">
                <FormError message={learnErr} />
                {learnMsg && <FormOk message={learnMsg} />}
              </div>
            </Card>
          )}

          <Section title="Transactions">
            <datalist id={DEALER_LIST_ID}>
              {dealerNames.map((d) => <option key={d} value={d} />)}
            </datalist>
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
              <label className="flex items-center gap-1 text-xs text-muted">
                Suggest from
                <select value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="rounded border border-line bg-surface px-2 py-1 text-xs text-ink">
                  {MIN_SCORES.map((s) => <option key={s} value={s}>{s}%</option>)}
                </select>
              </label>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search dealer, UPI ID, account, amount…"
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
                    <Th>Payer</Th>
                    <Th>Dealer</Th>
                    <Th className="text-right">Amount</Th>
                    <Th>Check</Th>
                  </tr>
                }
              >
                {filtered.map((t, i) => (
                  <tr key={i}>
                    <Td className="tabular whitespace-nowrap align-top">{t.date}</Td>
                    <Td className="align-top">
                      <div className="tabular" title={t.narration}>{t.vpa ?? <span className="text-muted text-xs">{t.narration}</span>}</div>
                      {t.account && <div className="text-[11px] text-muted tabular">a/c {t.account}</div>}
                    </Td>
                    <Td className="align-top">
                      <MatchCell t={t} />
                    </Td>
                    <Td className="tabular text-right whitespace-nowrap align-top">
                      <span className={t.credit > 0 ? "text-[var(--color-ok)]" : "text-muted"}>
                        {t.credit > 0 ? "+" : "−"}{money(t.credit > 0 ? t.credit : t.debit)}
                      </span>
                    </Td>
                    <Td className="align-top">
                      {t.vpa && t.tier !== "confirmed" && (
                        <ConfirmCell
                          key={`${t.date}-${t.narration}-${t.match.dealer ?? ""}`}
                          t={t}
                          firm={firm}
                          onConfirmed={onConfirmed}
                        />
                      )}
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

function MatchCell({ t }: { t: Txn }) {
  const m = t.match;
  if (t.tier === "not-upi") return <span className="text-muted">—</span>;
  if (t.tier === "unmapped") {
    return (
      <div>
        <span className="text-muted">Unmapped</span>
        {m.status === "suggested" && (
          <div className="text-[11px] text-muted">best guess {m.dealer} ({m.score}%) is below your threshold</div>
        )}
      </div>
    );
  }
  const tone = t.tier === "confirmed" ? "ok" : t.tier === "likely" ? "info" : "warn";
  const label = t.tier === "confirmed" ? "Confirmed" : `${t.tier === "likely" ? "Likely" : "Possible"} ${m.score}%`;
  return (
    <div className="max-w-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={t.tier === "confirmed" ? "font-medium text-ink" : "font-medium text-[var(--color-warn)]"}>{m.dealer}</span>
        <Badge tone={tone}>{label}</Badge>
      </div>
      <div className="text-[11px] text-muted">{m.reason}</div>
    </div>
  );
}

/** Check a guess: accept it, pick a runner-up, or type the right dealer. */
function ConfirmCell({
  t, firm, onConfirmed,
}: {
  t: Txn;
  firm: Firm;
  onConfirmed: (dealer: string, account: string | null, vpa: string | null, savedVpa: boolean) => void;
}) {
  const suggested = t.tier === "likely" || t.tier === "possible";
  const [dealer, setDealer] = useState(suggested ? t.match.dealer ?? "" : "");
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const others = suggested ? t.match.candidates.slice(1, 4) : [];

  function confirm() {
    setError(undefined);
    const vpa = t.vpa && !isMaskedVpa(t.vpa) ? t.vpa : null;
    start(async () => {
      const res = await confirmMatch({ firm, dealer_name: dealer, payer_account: t.account, upi_id: vpa });
      if (res.error) setError(res.error);
      else onConfirmed(dealer.trim(), res.savedAccount ? t.account : null, vpa, !!res.savedVpa);
    });
  }

  return (
    <div className="min-w-[14rem]">
      <div className="flex items-center gap-1">
        <input
          value={dealer}
          onChange={(e) => setDealer(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && confirm()}
          list={DEALER_LIST_ID}
          placeholder="Dealer…"
          className="w-full rounded border border-line px-2 py-1 text-xs"
        />
        <button type="button" className={BTN_SM} onClick={confirm} disabled={pending || !dealer.trim()}>
          {pending ? "…" : "Confirm"}
        </button>
      </div>
      {others.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {others.map((c) => (
            <button
              key={c.dealer}
              type="button"
              title={c.reason}
              onClick={() => setDealer(c.dealer)}
              className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-[var(--color-surface-2)]"
            >
              {c.dealer} {c.score}%
            </button>
          ))}
        </div>
      )}
      {error && <div className="mt-1 text-[11px] text-[var(--color-danger)]">{error}</div>}
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

import type { createSupabaseServerClient } from "@/lib/supabase/server";

type SupabaseServer = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export type LedgerRow = {
  worker_id: string;
  code: string;
  name: string;
  date: string;
  kind: "advance" | "salary";
  details: string;
  paid: number; // money paid to the employee (advance amount or salary net)
  recovered: number; // advance recovered (salary rows)
  balanceAfter: number; // this employee's outstanding-advance balance after the row
};

export type LedgerResult = {
  rows: LedgerRow[]; // most recent first
  totalSalary: number;
  totalAdvances: number;
  totalOutstanding: number;
  workerCount: number; // employees with ≥1 transaction
};

function one<T>(v: T | T[] | null): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/** period_start is the 1st of the month → "June 2026". */
export function monthLabel(periodStart: string): string {
  return new Date(periodStart + "T00:00:00").toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

type Adv = { worker_id: string; amount: number | string; disbursed_at: string | null; recovered_in_run: string | null; reason: string | null };
type RunRef = { period_start: string } | { period_start: string }[] | null;
type Line = { worker_id: string; run_id: string; net: number | string; paid_at: string | null; pay_mode: string | null; run: RunRef };

/**
 * Build the salary/advance ledger for one employee (workerId) or ALL of them
 * (workerId = null). The outstanding-advance balance is computed PER EMPLOYEE
 * chronologically, then rows are returned most-recent-first for display.
 */
export async function buildLedger(supabase: SupabaseServer, workerId: string | null): Promise<LedgerResult> {
  let advQ = supabase
    .from("advances")
    .select("worker_id, amount, disbursed_at, recovered_in_run, reason")
    .eq("status", "approved")
    .not("disbursed_at", "is", null);
  let lineQ = supabase
    .from("payroll_lines")
    .select("worker_id, run_id, net, paid_at, pay_mode, run:payroll_runs(period_start)")
    .not("paid_at", "is", null);
  if (workerId) {
    advQ = advQ.eq("worker_id", workerId);
    lineQ = lineQ.eq("worker_id", workerId);
  }

  const [advRes, lineRes, workerRes] = await Promise.all([
    advQ,
    lineQ,
    supabase.from("workers").select("id, full_name, employee_code"),
  ]);

  const advances = (advRes.data ?? []) as Adv[];
  const lines = (lineRes.data ?? []) as Line[];
  const wmap = new Map<string, { name: string; code: string }>();
  for (const w of workerRes.data ?? []) {
    wmap.set(w.id as string, { name: w.full_name as string, code: w.employee_code as string });
  }

  type Ev =
    | { worker_id: string; date: string; kind: "advance"; amount: number; details: string }
    | { worker_id: string; date: string; kind: "salary"; net: number; recovered: number; details: string };

  const byWorker = new Map<string, Ev[]>();
  const push = (wid: string, ev: Ev) => {
    const list = byWorker.get(wid);
    if (list) list.push(ev);
    else byWorker.set(wid, [ev]);
  };

  for (const a of advances) {
    if (!a.disbursed_at) continue;
    push(a.worker_id, {
      worker_id: a.worker_id,
      date: a.disbursed_at,
      kind: "advance",
      amount: Number(a.amount),
      details: a.reason?.trim() ? `Advance — ${a.reason.trim()}` : "Advance",
    });
  }
  for (const l of lines) {
    if (!l.paid_at) continue;
    const recovered = advances
      .filter((a) => a.worker_id === l.worker_id && a.recovered_in_run === l.run_id)
      .reduce((s, a) => s + Number(a.amount), 0);
    const run = one(l.run);
    const period = run ? monthLabel(run.period_start) : "salary";
    push(l.worker_id, {
      worker_id: l.worker_id,
      date: l.paid_at,
      kind: "salary",
      net: Number(l.net),
      recovered,
      details: `Salary — ${period}${l.pay_mode ? ` · ${l.pay_mode}` : ""}`,
    });
  }

  const rows: LedgerRow[] = [];
  let totalSalary = 0;
  let totalAdvances = 0;
  let totalOutstanding = 0;

  for (const [wid, evs] of byWorker) {
    evs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === "advance" ? -1 : 1));
    const w = wmap.get(wid) ?? { name: "Unknown", code: "" };
    let outstanding = 0;
    for (const e of evs) {
      if (e.kind === "advance") {
        outstanding += e.amount;
        totalAdvances += e.amount;
        rows.push({ worker_id: wid, code: w.code, name: w.name, date: e.date, kind: "advance", details: e.details, paid: e.amount, recovered: 0, balanceAfter: outstanding });
      } else {
        outstanding -= e.recovered;
        totalSalary += e.net;
        rows.push({ worker_id: wid, code: w.code, name: w.name, date: e.date, kind: "salary", details: e.details, paid: e.net, recovered: e.recovered, balanceAfter: outstanding });
      }
    }
    totalOutstanding += outstanding;
  }

  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // most recent first

  return { rows, totalSalary, totalAdvances, totalOutstanding, workerCount: byWorker.size };
}

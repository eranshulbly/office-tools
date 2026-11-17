import Link from "next/link";
import { requireFeature } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  PageHeader,
  Card,
  Section,
  Badge,
  Table,
  Th,
  Td,
  Empty,
} from "@/components/ui";
import type { RunStatus } from "@/lib/types";
import { NewRunForm } from "./NewRunForm";

type RunRow = {
  id: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  status: RunStatus;
  computed_at: string | null;
  approved_at: string | null;
};

const statusTone: Record<RunStatus, "neutral" | "info" | "warn" | "ok"> = {
  draft: "neutral",
  admin_approved: "info",
  disbursing: "warn",
  closed: "ok",
};

function ymd(year: number, month1: number, day: number): string {
  return `${year}-${String(month1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The 2nd Saturday of a month (day-of-month) — falls between the 8th and 14th. */
function secondSaturday(year: number, month0: number): number {
  for (let d = 8; d <= 14; d++) if (new Date(year, month0, d).getDay() === 6) return d;
  return 14;
}

/**
 * Suggested default run: the PREVIOUS full calendar month (1st → last day),
 * with the pay date defaulting to the 2nd Saturday of THIS month. Both are
 * editable — the admin computes and disburses whenever they choose.
 * e.g. in July the default is 1–30 June, pay date = 2nd Saturday of July.
 */
function suggestedRun() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-based current month
  const prev = new Date(y, m - 1, 1);
  const py = prev.getFullYear();
  const pm = prev.getMonth();
  const lastOfPrev = new Date(py, pm + 1, 0).getDate();
  return {
    period_start: ymd(py, pm + 1, 1),
    period_end: ymd(py, pm + 1, lastOfPrev),
    pay_date: ymd(y, m + 1, secondSaturday(y, m)),
  };
}

export default async function PayrollPage() {
  await requireFeature("payroll");
  const supabase = await createSupabaseServerClient();

  const { data: runs } = await supabase
    .from("payroll_runs")
    .select("id, period_start, period_end, pay_date, status, computed_at, approved_at")
    .order("period_start", { ascending: false });

  const defaults = suggestedRun();

  const runList = (runs ?? []) as RunRow[];

  return (
    <div>
      <PageHeader title="Payroll" subtitle="Monthly salary runs — compute, approve, reconcile." />

      <Section title="New run">
        <Card className="p-4">
          <NewRunForm
            defaultPeriodStart={defaults.period_start}
            defaultPeriodEnd={defaults.period_end}
            defaultPayDate={defaults.pay_date}
          />
        </Card>
      </Section>

      <Section title="Runs">
        {runList.length === 0 ? (
          <Empty>No payroll runs yet. Create the first one above.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <Th>Period</Th>
                <Th>Pay date</Th>
                <Th>Status</Th>
                <Th>Computed</Th>
                <Th>Approved</Th>
                <Th />
              </tr>
            }
          >
            {runList.map((run) => (
              <tr key={run.id}>
                <Td className="tabular">
                  {run.period_start} → {run.period_end}
                </Td>
                <Td className="tabular">{run.pay_date}</Td>
                <Td>
                  <Badge tone={statusTone[run.status]}>{run.status}</Badge>
                </Td>
                <Td className="text-muted">
                  {run.computed_at ? new Date(run.computed_at).toLocaleString("en-IN") : "—"}
                </Td>
                <Td className="text-muted">
                  {run.approved_at ? new Date(run.approved_at).toLocaleString("en-IN") : "—"}
                </Td>
                <Td>
                  <Link href={`/payroll/${run.id}`} className="text-brand hover:underline">
                    Open
                  </Link>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}

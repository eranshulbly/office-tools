import { requireFeature } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  PageHeader, Card, Section, Badge, Table, Th, Td, Empty, money,
} from "@/components/ui";
import type { SelectOption } from "@/components/SearchableSelect";
import { EmployeePicker } from "./EmployeePicker";
import { buildLedger } from "./ledger";

export const dynamic = "force-dynamic";

function dateLabel(ts: string): string {
  return new Date(ts).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export default async function StatementsPage({
  searchParams,
}: {
  searchParams: Promise<{ worker?: string }>;
}) {
  await requireFeature("statements");
  const { worker: workerId } = await searchParams;
  const supabase = await createSupabaseServerClient();

  const { data: workerData } = await supabase
    .from("workers")
    .select("id, full_name, employee_code, is_active")
    .order("is_active", { ascending: false })
    .order("full_name");
  const employees: SelectOption[] = [
    { value: "all", label: "All employees" },
    ...(workerData ?? []).map((w) => ({
      value: w.id as string,
      label: `${w.full_name} (${w.employee_code})${w.is_active ? "" : " — inactive"}`,
    })),
  ];

  return (
    <div>
      <PageHeader
        title="Employee ledger"
        subtitle="Every salary payment and advance for an employee, with the outstanding-advance balance after each transaction."
        actions={
          workerId ? (
            <a
              href={`/statements/export?worker=${workerId}`}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium text-ink hover:bg-[var(--color-surface-2)]"
            >
              Download Excel
            </a>
          ) : undefined
        }
      />

      <Card className="p-4 mb-6">
        <EmployeePicker employees={employees} current={workerId ?? ""} />
      </Card>

      {!workerId ? (
        <Empty>Search and select an employee (or “All employees”) to see salary &amp; advance history.</Empty>
      ) : (
        await LedgerView({ workerId })
      )}
    </div>
  );
}

async function LedgerView({ workerId }: { workerId: string }) {
  const all = workerId === "all";
  const supabase = await createSupabaseServerClient();

  const result = await buildLedger(supabase, all ? null : workerId);

  // Single-employee header (name, code, monthly salary).
  let header: { name: string; code: string; salary: number | null } | null = null;
  if (!all) {
    const { data } = await supabase
      .from("workers")
      .select("full_name, employee_code, monthly_salary")
      .eq("id", workerId)
      .single();
    if (!data) return <Empty>Employee not found.</Empty>;
    header = { name: data.full_name as string, code: data.employee_code as string, salary: data.monthly_salary as number | null };
  }

  const { rows, totalSalary, totalAdvances, totalOutstanding, workerCount } = result;

  return (
    <>
      <Section title={all ? "All employees" : `${header!.name} (${header!.code})`}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {all ? (
            <Stat label="Employees" value={String(workerCount)} />
          ) : (
            <Stat label="Monthly salary" value={header!.salary != null ? money(header!.salary) : "—"} />
          )}
          <Stat label="Total salary paid" value={money(totalSalary)} />
          <Stat label="Total advances paid" value={money(totalAdvances)} />
          <Stat label={all ? "Total outstanding" : "Outstanding advance"} value={money(totalOutstanding)} tone={totalOutstanding > 0 ? "warn" : "ok"} />
        </div>
      </Section>

      <Section title={`Transactions (${rows.length})`}>
        {rows.length === 0 ? (
          <Empty>No salary payments or advances recorded yet.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <Th>Date</Th>
                {all && <Th>Employee</Th>}
                <Th>Type</Th>
                <Th>Details</Th>
                <Th className="text-right">Paid to employee</Th>
                <Th className="text-right">Advance recovered</Th>
                <Th className="text-right">Outstanding advance</Th>
              </tr>
            }
          >
            {rows.map((r, i) => (
              <tr key={i}>
                <Td className="tabular whitespace-nowrap">{dateLabel(r.date)}</Td>
                {all && (
                  <Td className="whitespace-nowrap">
                    <span className="text-ink">{r.name}</span>{" "}
                    <span className="text-muted text-xs">{r.code}</span>
                  </Td>
                )}
                <Td>
                  <Badge tone={r.kind === "advance" ? "info" : "neutral"}>
                    {r.kind === "advance" ? "Advance" : "Salary"}
                  </Badge>
                </Td>
                <Td>{r.details}</Td>
                <Td className="tabular text-right">{money(r.paid)}</Td>
                <Td className="tabular text-right">{r.recovered > 0 ? money(r.recovered) : "—"}</Td>
                <Td className="tabular text-right font-medium">{money(r.balanceAfter)}</Td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-2 text-xs text-muted">
          “Outstanding advance” is each employee’s balance still to be recovered from future salary after that
          transaction: up when an advance is paid, down when a salary run recovers it.
        </p>
      </Section>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" | "ok" }) {
  const color = tone === "warn" ? "text-[var(--color-warn)]" : tone === "ok" ? "text-[var(--color-ok)]" : "text-ink";
  return (
    <Card className="p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular ${color}`}>{value}</div>
    </Card>
  );
}

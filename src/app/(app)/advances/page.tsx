import { requireRole, requireSuiteAccess } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { RequestStatus } from "@/lib/types";
import {
  PageHeader,
  Card,
  Section,
  Badge,
  Table,
  Th,
  Td,
  Empty,
  money,
} from "@/components/ui";
import { AdvanceForm, type AdvanceWorker } from "./AdvanceForm";
import { DisburseButton } from "./DisburseButton";

export const dynamic = "force-dynamic";

type AdvanceRow = {
  id: string;
  amount: number;
  reason: string;
  status: RequestStatus;
  requested_at: string;
  disbursed_at: string | null;
  decision_reason: string | null;
  worker: { full_name: string; employee_code: string } | null;
};

const statusTone: Record<RequestStatus, "warn" | "ok" | "danger"> = {
  pending: "warn",
  approved: "ok",
  rejected: "danger",
};

function ts(v: string | null): string {
  return v ? new Date(v).toLocaleString("en-IN") : "—";
}

/** Parse the advance_cap_multiple jsonb value (number or numeric string). */
function parseCapMultiple(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 1.0;
}

export default async function AdvancesPage() {
  requireSuiteAccess(await requireRole("manager"), "payroll");
  const supabase = await createSupabaseServerClient();

  const [workersRes, outstandingRes, advancesRes, capRes] = await Promise.all([
    supabase
      .from("workers")
      .select("id, full_name, employee_code, monthly_salary")
      .eq("is_active", true)
      .order("full_name"),
    // Outstanding = approved + disbursed + not-yet-recovered advances (§3.7 / conventions).
    supabase
      .from("advances")
      .select("worker_id, amount")
      .eq("status", "approved")
      .not("disbursed_at", "is", null)
      .is("recovered_in_run", null),
    supabase
      .from("advances")
      .select(
        "id, amount, reason, status, requested_at, disbursed_at, decision_reason, worker:workers(full_name, employee_code)"
      )
      .order("requested_at", { ascending: false }),
    supabase.from("settings").select("value").eq("key", "advance_cap_multiple").single(),
  ]);

  const capMultiple = parseCapMultiple(capRes.data?.value);

  // Sum unrecovered disbursed advances per worker.
  const outstandingByWorker = new Map<string, number>();
  for (const row of outstandingRes.data ?? []) {
    const wid = row.worker_id as string;
    outstandingByWorker.set(
      wid,
      (outstandingByWorker.get(wid) ?? 0) + Number(row.amount ?? 0)
    );
  }

  const workers: AdvanceWorker[] = (workersRes.data ?? []).map((w) => ({
    id: w.id as string,
    label: `${w.full_name} (${w.employee_code})`,
    outstanding: outstandingByWorker.get(w.id as string) ?? 0,
    salary: Number(w.monthly_salary ?? 0),
  }));

  const rows = (advancesRes.data ?? []) as unknown as AdvanceRow[];
  const loadError =
    workersRes.error?.message ??
    outstandingRes.error?.message ??
    advancesRes.error?.message;

  return (
    <div>
      <PageHeader
        title="Advances"
        subtitle="Request an advance and record cash handover. Admin approves or rejects."
      />

      {loadError && (
        <div className="mb-6 rounded border border-red-200 bg-red-50 text-[var(--color-danger)] px-3 py-2 text-sm">
          {loadError}
        </div>
      )}

      <Section title="Request advance">
        <Card className="p-4 max-w-2xl">
          <AdvanceForm workers={workers} capMultiple={capMultiple} />
        </Card>
      </Section>

      <Section title="Advances">
        {rows.length === 0 ? (
          <Empty>No advances yet.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <Th>Employee</Th>
                <Th className="text-right">Amount</Th>
                <Th>Reason</Th>
                <Th>Status</Th>
                <Th>Disbursed</Th>
                <Th></Th>
              </tr>
            }
          >
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>
                  {r.worker
                    ? `${r.worker.full_name} (${r.worker.employee_code})`
                    : "—"}
                </Td>
                <Td className="text-right tabular">{money(r.amount)}</Td>
                <Td>{r.reason}</Td>
                <Td>
                  <Badge tone={statusTone[r.status]}>{r.status}</Badge>
                  {r.status === "rejected" && r.decision_reason && (
                    <div className="text-muted text-xs mt-0.5">{r.decision_reason}</div>
                  )}
                </Td>
                <Td>{ts(r.disbursed_at)}</Td>
                <Td>
                  {r.status === "approved" && r.disbursed_at === null ? (
                    <DisburseButton id={r.id} />
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}

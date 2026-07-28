import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
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
  money,
} from "@/components/ui";
import type { RunStatus, PayMode, ComponentType } from "@/lib/types";
import { WorkerCell } from "@/components/WorkerAvatar";
import { signedPhotoUrlMap } from "@/lib/storage";
import { DraftControls, ReopenForm } from "../RunControls";
import { LineBreakdownButton } from "./LineBreakdownButton";

type RunRow = {
  id: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  status: RunStatus;
  computed_at: string | null;
  approved_at: string | null;
  closed_at: string | null;
};

type LineComponent = {
  id: string;
  code: string;
  label: string;
  type: ComponentType;
  amount: string;
};

type LineRow = {
  id: string;
  worker_id: string;
  salary_snapshot: string;
  daily_rate_snapshot: string;
  full_days: number;
  half_days: number;
  absent_days: number;
  extra_days: number;
  leave_units: string;
  net: string;
  pay_mode: PayMode | null;
  paid_at: string | null;
  payment_reference: string | null;
  workers: { full_name: string; employee_code: string; photo_path: string | null } | null;
  payroll_line_components: LineComponent[];
};

type ExceptionDay = {
  worker_id: string;
  day: string;
  status: string;
  workers: { full_name: string; employee_code: string } | null;
};

type PendingAdjustment = {
  id: string;
  worker_id: string;
  day: string;
  reason: string;
  workers: { full_name: string; employee_code: string } | null;
};

const statusTone: Record<RunStatus, "neutral" | "info" | "warn" | "ok"> = {
  draft: "neutral",
  admin_approved: "info",
  disbursing: "warn",
  closed: "ok",
};

function num(v: string | number | null | undefined): number {
  const n = typeof v === "string" ? parseFloat(v) : v ?? 0;
  return Number.isFinite(n) ? (n as number) : 0;
}

function workerName(w: { full_name: string; employee_code: string } | null): string {
  return w ? `${w.full_name} (${w.employee_code})` : "—";
}

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole("admin");
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: runData, error: runErr } = await supabase
    .from("payroll_runs")
    .select("id, period_start, period_end, pay_date, status, computed_at, approved_at, closed_at")
    .eq("id", id)
    .single();

  if (runErr || !runData) notFound();
  const run = runData as RunRow;

  // Lines + nested worker + components in one query.
  const { data: lineData } = await supabase
    .from("payroll_lines")
    .select(
      "id, worker_id, salary_snapshot, daily_rate_snapshot, full_days, half_days, absent_days, extra_days, leave_units, net, pay_mode, paid_at, payment_reference, workers(full_name, employee_code, photo_path), payroll_line_components(id, code, label, type, amount)"
    )
    .eq("run_id", id);

  const lines = ((lineData ?? []) as unknown as LineRow[]).slice().sort((a, b) =>
    (a.workers?.employee_code ?? "").localeCompare(b.workers?.employee_code ?? "")
  );

  // Batch-sign worker photos for the breakdown table (one round-trip).
  const photoMap = await signedPhotoUrlMap(lines.map((l) => l.workers?.photo_path));

  // Exceptions panel — only meaningful while draft (spec §3.6).
  let unresolved: ExceptionDay[] = [];
  let pendingAdjustments: PendingAdjustment[] = [];
  if (run.status === "draft") {
    const [{ data: uData }, { data: pData }] = await Promise.all([
      supabase
        .from("attendance_days")
        .select("worker_id, day, status, workers(full_name, employee_code)")
        .in("status", ["unresolved", "late_review"])
        .gte("day", run.period_start)
        .lte("day", run.period_end)
        .order("day"),
      supabase
        .from("adjustments")
        .select("id, worker_id, day, reason, workers(full_name, employee_code)")
        .eq("status", "pending")
        .gte("day", run.period_start)
        .lte("day", run.period_end)
        .order("day"),
    ]);
    unresolved = (uData ?? []) as unknown as ExceptionDay[];
    pendingAdjustments = (pData ?? []) as unknown as PendingAdjustment[];
  }
  const exceptionCount = unresolved.length + pendingAdjustments.length;
  const blocked = exceptionCount > 0;

  // Reconciliation.
  const approvedTotal = lines.reduce((acc, l) => acc + num(l.net), 0);
  const paidLines = lines.filter((l) => l.paid_at != null);
  const disbursedTotal = paidLines.reduce((acc, l) => acc + num(l.net), 0);
  const outstandingTotal = approvedTotal - disbursedTotal;
  const unpaidLines = lines.filter((l) => l.paid_at == null);

  return (
    <div>
      <PageHeader
        title={`Run ${run.period_start} → ${run.period_end}`}
        subtitle={`Pay date ${run.pay_date}`}
        actions={
          <Link href="/payroll" className="text-brand hover:underline text-sm">
            ← All runs
          </Link>
        }
      />

      <Section title="Status">
        <Card className="p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge tone={statusTone[run.status]}>{run.status}</Badge>
            <span className="text-muted">
              Computed: {run.computed_at ? new Date(run.computed_at).toLocaleString("en-IN") : "—"}
            </span>
            <span className="text-muted">
              Approved: {run.approved_at ? new Date(run.approved_at).toLocaleString("en-IN") : "—"}
            </span>
            {run.closed_at && (
              <span className="text-muted">
                Closed: {new Date(run.closed_at).toLocaleString("en-IN")}
              </span>
            )}
          </div>

          {run.status === "draft" && (
            <>
              {blocked && (
                <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-[var(--color-warn)]">
                  Payroll refuses to run: {exceptionCount} exception(s) in the period. Clear the
                  list below before computing.
                </div>
              )}
              <DraftControls
                runId={run.id}
                blocked={blocked}
                computed={run.computed_at != null}
                hasLines={lines.length > 0}
              />
            </>
          )}

          {run.status === "admin_approved" && <ReopenForm runId={run.id} />}

          {(run.status === "disbursing" || run.status === "closed") && (
            <p className="text-sm text-muted">
              Figures are frozen. The manager disburses lines from the Disburse screen.
            </p>
          )}
        </Card>
      </Section>

      {run.status === "draft" && exceptionCount > 0 && (
        <Section title={`Exceptions (${exceptionCount}) — block payroll`}>
          <div className="space-y-4">
            {unresolved.length > 0 && (
              <div>
                <p className="text-sm text-muted mb-2">
                  Unresolved or late-review days (punched in, never out and no adjustment filed, or
                  a late arrival awaiting review).
                </p>
                <Table
                  head={
                    <tr>
                      <Th>Employee</Th>
                      <Th>Day</Th>
                      <Th>Status</Th>
                    </tr>
                  }
                >
                  {unresolved.map((u) => (
                    <tr key={`${u.worker_id}-${u.day}`}>
                      <Td>{workerName(u.workers)}</Td>
                      <Td className="tabular">{u.day}</Td>
                      <Td>
                        <Badge tone="danger">{u.status}</Badge>
                      </Td>
                    </tr>
                  ))}
                </Table>
              </div>
            )}
            {pendingAdjustments.length > 0 && (
              <div>
                <p className="text-sm text-muted mb-2">
                  Pending adjustments awaiting an admin decision.
                </p>
                <Table
                  head={
                    <tr>
                      <Th>Employee</Th>
                      <Th>Day</Th>
                      <Th>Reason</Th>
                    </tr>
                  }
                >
                  {pendingAdjustments.map((p) => (
                    <tr key={p.id}>
                      <Td>{workerName(p.workers)}</Td>
                      <Td className="tabular">{p.day}</Td>
                      <Td className="text-muted">{p.reason}</Td>
                    </tr>
                  ))}
                </Table>
              </div>
            )}
          </div>
        </Section>
      )}

      <Section title="Reconciliation">
        <Card className="p-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-muted">Approved total (sum of net)</div>
              <div className="tabular text-base font-semibold text-ink">{money(approvedTotal)}</div>
            </div>
            <div>
              <div className="text-muted">Disbursed ({paidLines.length} paid)</div>
              <div className="tabular text-base font-semibold text-ink">{money(disbursedTotal)}</div>
            </div>
            <div>
              <div className="text-muted">Outstanding ({unpaidLines.length} unpaid)</div>
              <div className="tabular text-base font-semibold text-ink">
                {money(outstandingTotal)}
              </div>
            </div>
          </div>

          {unpaidLines.length > 0 && (
            <div className="mt-4">
              <div className="text-muted text-sm mb-1">Unpaid employees</div>
              <div className="text-sm text-ink">
                {unpaidLines.map((l) => workerName(l.workers)).join(", ")}
              </div>
            </div>
          )}
        </Card>
      </Section>

      <Section title={`Per-employee breakdown (${lines.length})`}>
        {lines.length === 0 ? (
          <Empty>No lines yet. Compute the run to generate the breakdown.</Empty>
        ) : (
          <>
          <p className="text-muted text-xs mb-2">Click an employee&apos;s net to see the component breakdown.</p>
          <Table
            head={
              <tr>
                <Th>Employee</Th>
                <Th>Code</Th>
                <Th className="text-right">Salary</Th>
                <Th className="text-right">Daily rate</Th>
                <Th className="text-right">Full</Th>
                <Th className="text-right">Absent</Th>
                <Th className="text-right">Extra</Th>
                <Th className="text-right">Leave units</Th>
                <Th className="text-right">Net</Th>
                <Th>Pay</Th>
              </tr>
            }
          >
            {lines.map((l) => {
              return (
                <tr key={l.id} className="align-top">
                  <Td>
                    <WorkerCell
                      name={l.workers?.full_name ?? "—"}
                      url={l.workers?.photo_path ? photoMap[l.workers.photo_path] : null}
                      size="sm"
                    />
                  </Td>
                  <Td className="tabular">{l.workers?.employee_code ?? "—"}</Td>
                  <Td className="tabular text-right">{money(l.salary_snapshot)}</Td>
                  <Td className="tabular text-right">{money(l.daily_rate_snapshot)}</Td>
                  <Td className="tabular text-right">{l.full_days}</Td>
                  <Td className="tabular text-right">{l.absent_days}</Td>
                  <Td className="tabular text-right">{l.extra_days}</Td>
                  <Td className="tabular text-right">{num(l.leave_units)}</Td>
                  <Td className="text-right">
                    <LineBreakdownButton
                      name={l.workers?.full_name ?? "Employee"}
                      net={l.net}
                      components={l.payroll_line_components}
                    />
                  </Td>
                  <Td>
                    {l.paid_at ? (
                      <div className="text-xs">
                        <Badge tone="ok">{l.pay_mode ?? "paid"}</Badge>
                        <div className="text-muted mt-0.5">
                          {new Date(l.paid_at).toLocaleString("en-IN")}
                        </div>
                        {l.payment_reference && (
                          <div className="text-muted">ref: {l.payment_reference}</div>
                        )}
                      </div>
                    ) : (
                      <Badge tone="neutral">unpaid</Badge>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
          </>
        )}
      </Section>
    </div>
  );
}

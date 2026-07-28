import { requireRole, requireSuiteAccess } from "@/lib/auth";
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
import type { RunStatus, PayMode } from "@/lib/types";
import { WorkerCell } from "@/components/WorkerAvatar";
import { signedPhotoUrlMap } from "@/lib/storage";
import { DisburseRow } from "./DisburseRow";
import { DisburseAdvanceButton } from "./DisburseAdvanceButton";

type AdvanceRow = {
  id: string;
  amount: number | string;
  reason: string | null;
  requested_at: string;
  decided_at: string | null;
  disbursed_at: string | null;
  worker: {
    full_name: string;
    employee_code: string;
    photo_path: string | null;
    group_id: string | null;
    worker_groups: { name: string } | null;
  } | null;
};

type RunRow = {
  id: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  status: RunStatus;
};

type LineRow = {
  id: string;
  run_id: string;
  worker_id: string;
  net: string;
  pay_mode: PayMode | null;
  paid_at: string | null;
  payment_reference: string | null;
  workers: {
    full_name: string;
    employee_code: string;
    photo_path: string | null;
    worker_groups: { name: string } | null;
  } | null;
};

function num(v: string | number | null | undefined): number {
  const n = typeof v === "string" ? parseFloat(v) : v ?? 0;
  return Number.isFinite(n) ? (n as number) : 0;
}

export default async function DisbursePage() {
  const profile = await requireRole("admin", "manager");
  requireSuiteAccess(profile, "payroll");
  const isAdmin = profile.role === "admin";
  const supabase = await createSupabaseServerClient();

  // RLS lets the manager see runs only once admin_approved+. Payable runs are
  // admin_approved or disbursing; closed runs are fully paid, drafts invisible.
  const { data: runData } = await supabase
    .from("payroll_runs")
    .select("id, period_start, period_end, pay_date, status")
    .in("status", ["admin_approved", "disbursing"])
    .order("pay_date", { ascending: false });

  const runs = (runData ?? []) as RunRow[];

  // ── Approved advances still outstanding (not yet recovered from salary). Both
  // pending handover AND already-disbursed stay listed — like salary lines — so
  // the transaction remains visible after "Mark disbursed". Undisbursed first.
  const { data: advData } = await supabase
    .from("advances")
    .select(
      "id, amount, reason, requested_at, decided_at, disbursed_at, worker:workers(full_name, employee_code, photo_path, group_id, worker_groups(name))"
    )
    .eq("status", "approved")
    .is("recovered_in_run", null)
    .order("disbursed_at", { ascending: true, nullsFirst: true })
    .order("decided_at", { ascending: true });
  let advances = (advData ?? []) as unknown as AdvanceRow[];

  // Managers see only advances for employees in their groups (admin sees all).
  if (!isAdmin) {
    const { data: mga } = await supabase
      .from("manager_group_access")
      .select("group_id")
      .eq("manager_id", profile.id);
    const myGroups = new Set((mga ?? []).map((r) => r.group_id as string));
    advances = advances.filter((a) => a.worker?.group_id && myGroups.has(a.worker.group_id));
  }
  const advancePhotoMap = await signedPhotoUrlMap(advances.map((a) => a.worker?.photo_path));

  let linesByRun = new Map<string, LineRow[]>();
  let photoMap: Record<string, string> = {};
  if (runs.length > 0) {
    const { data: lineData } = await supabase
      .from("payroll_lines")
      .select(
        "id, run_id, worker_id, net, pay_mode, paid_at, payment_reference, workers(full_name, employee_code, photo_path, worker_groups(name))"
      )
      .in(
        "run_id",
        runs.map((r) => r.id)
      );

    const lines = ((lineData ?? []) as unknown as LineRow[]).slice().sort((a, b) =>
      (a.workers?.employee_code ?? "").localeCompare(b.workers?.employee_code ?? "")
    );
    photoMap = await signedPhotoUrlMap(lines.map((l) => l.workers?.photo_path));
    linesByRun = lines.reduce((map, line) => {
      const arr = map.get(line.run_id) ?? [];
      arr.push(line);
      map.set(line.run_id, arr);
      return map;
    }, new Map<string, LineRow[]>());
  }

  return (
    <div>
      <PageHeader
        title="Disburse"
        subtitle={
          isAdmin
            ? "Record approved advances and mark salary lines paid. You see every employee; managers see only their groups."
            : "Record approved advances and mark salary lines paid, scoped to your assigned employee groups."
        }
      />

      {(() => {
        const pending = advances.filter((a) => a.disbursed_at == null);
        return (
          <Section title={`Approved advances — ${pending.length} to disburse of ${advances.length} outstanding`}>
            {advances.length === 0 ? (
              <Empty>No outstanding advances.</Empty>
            ) : (
              <Table
                head={
                  <tr>
                    <Th>Employee</Th>
                    <Th className="text-right">Amount</Th>
                    <Th>Reason</Th>
                    <Th>Approved</Th>
                    <Th className="text-right">Status / action</Th>
                  </tr>
                }
              >
                {advances.map((a) => (
                  <tr key={a.id} className="align-top">
                    <Td>
                      <WorkerCell
                        name={a.worker?.full_name ?? "—"}
                        code={a.worker?.employee_code}
                        url={a.worker?.photo_path ? advancePhotoMap[a.worker.photo_path] : null}
                        size="sm"
                      />
                      {a.worker?.worker_groups?.name && (
                        <div className="text-muted mt-0.5 text-xs">{a.worker.worker_groups.name}</div>
                      )}
                    </Td>
                    <Td className="tabular text-right font-semibold">{money(a.amount)}</Td>
                    <Td className="text-sm">{a.reason ?? "—"}</Td>
                    <Td className="text-muted text-xs whitespace-nowrap">
                      {a.decided_at ? new Date(a.decided_at).toLocaleDateString("en-IN") : "—"}
                    </Td>
                    <Td className="text-right">
                      {a.disbursed_at ? (
                        <div className="text-xs">
                          <Badge tone="ok">Disbursed</Badge>
                          <div className="text-muted mt-0.5">
                            {new Date(a.disbursed_at).toLocaleString("en-IN")}
                          </div>
                        </div>
                      ) : (
                        <DisburseAdvanceButton id={a.id} />
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
        );
      })()}

      <Section title="Salary runs">
        {runs.length === 0 && <Empty>No approved runs to disburse right now.</Empty>}
      </Section>

      {runs.length > 0 && (
        runs.map((run) => {
          const lines = linesByRun.get(run.id) ?? [];
          const total = lines.reduce((acc, l) => acc + num(l.net), 0);
          const paid = lines.filter((l) => l.paid_at != null);
          const disbursed = paid.reduce((acc, l) => acc + num(l.net), 0);
          const unpaid = lines.filter((l) => l.paid_at == null);

          return (
            <Section
              key={run.id}
              title={`${run.period_start} → ${run.period_end} · pay ${run.pay_date}`}
            >
              <Card className="p-4 mb-3">
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <Badge tone={run.status === "disbursing" ? "warn" : "info"}>{run.status}</Badge>
                  <span className="text-ink">
                    <span className="font-semibold">{paid.length}</span> of{" "}
                    <span className="font-semibold">{lines.length}</span> paid
                  </span>
                  <span className="tabular text-ink">
                    <span className="font-semibold">{money(disbursed)}</span> of{" "}
                    <span className="font-semibold">{money(total)}</span> disbursed
                  </span>
                  <span className="tabular text-muted">
                    {money(total - disbursed)} outstanding
                  </span>
                </div>
              </Card>

              {lines.length === 0 ? (
                <Empty>No lines on this run.</Empty>
              ) : (
                <Table
                  head={
                    <tr>
                      <Th>Employee</Th>
                      <Th className="text-right">Net</Th>
                      <Th>Payment</Th>
                    </tr>
                  }
                >
                  {unpaid.map((l) => (
                    <DisburseRow
                      key={l.id}
                      lineId={l.id}
                      workerId={l.worker_id}
                      workerName={l.workers?.full_name ?? "—"}
                      workerCode={l.workers?.employee_code}
                      workerGroup={l.workers?.worker_groups?.name ?? null}
                      photoUrl={l.workers?.photo_path ? photoMap[l.workers.photo_path] : null}
                      net={l.net}
                    />
                  ))}
                  {paid.map((l) => (
                    <tr key={l.id} className="align-top">
                      <Td>
                        <WorkerCell
                          name={l.workers?.full_name ?? "—"}
                          code={l.workers?.employee_code}
                          url={l.workers?.photo_path ? photoMap[l.workers.photo_path] : null}
                          size="sm"
                        />
                        {l.workers?.worker_groups?.name && (
                          <div className="text-muted mt-0.5 text-xs">
                            {l.workers.worker_groups.name}
                          </div>
                        )}
                      </Td>
                      <Td className="tabular text-right font-semibold">{money(l.net)}</Td>
                      <Td>
                        <div className="text-xs">
                          <Badge tone="ok">{l.pay_mode ?? "paid"}</Badge>
                          <div className="text-muted mt-0.5">
                            {l.paid_at ? new Date(l.paid_at).toLocaleString("en-IN") : ""}
                          </div>
                          {l.payment_reference && (
                            <div className="text-muted">ref: {l.payment_reference}</div>
                          )}
                        </div>
                      </Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Section>
          );
        })
      )}
    </div>
  );
}

import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageHeader, Section, Table, Th, Td, Button, Empty, money } from "@/components/ui";
import { WorkerAvatar } from "@/components/WorkerAvatar";
import { signedPhotoUrlMap } from "@/lib/storage";
import { approveAdvanceAction } from "../approvals/actions";
import { RejectButton } from "../approvals/RejectButton";

/**
 * Payroll → Advance approvals: the pending advance queue (spec §3.7.2). Shows the
 * worker's current outstanding balance and monthly salary at the point of the
 * admin's decision. Attendance-adjustment approvals live under HR.
 */

export const dynamic = "force-dynamic";

function one<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

type Named = { full_name: string | null } | null;

type AdvRow = {
  id: string;
  worker_id: string;
  amount: string;
  reason: string;
  requested_at: string;
  worker: { full_name: string | null; monthly_salary: string | null; photo_path: string | null } | null;
  requester: Named;
};

function fmtTs(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-IN");
}

export default async function AdvanceApprovalsPage() {
  await requireRole("admin");
  const supabase = await createSupabaseServerClient();

  const { data: advData, error: advError } = await supabase
    .from("advances")
    .select(
      "id, worker_id, amount, reason, requested_at, " +
        "worker:workers(full_name, monthly_salary, photo_path), " +
        "requester:profiles!requested_by(full_name)"
    )
    .eq("status", "pending")
    .order("requested_at", { ascending: true });

  const advances = (advData ?? []) as unknown as AdvRow[];

  // Outstanding = approved + disbursed + not-yet-recovered advances.
  const advWorkerIds = [...new Set(advances.map((a) => a.worker_id))];
  const outstandingByWorker = new Map<string, number>();
  if (advWorkerIds.length) {
    const { data } = await supabase
      .from("advances")
      .select("worker_id, amount")
      .in("worker_id", advWorkerIds)
      .eq("status", "approved")
      .not("disbursed_at", "is", null)
      .is("recovered_in_run", null);
    for (const r of (data ?? []) as { worker_id: string; amount: string }[]) {
      outstandingByWorker.set(r.worker_id, (outstandingByWorker.get(r.worker_id) ?? 0) + Number(r.amount));
    }
  }

  const photoMap = await signedPhotoUrlMap(advances.map((a) => a.worker?.photo_path));

  return (
    <div>
      <PageHeader
        title="Advance approvals"
        subtitle="Decide pending advance requests. Rejections require a reason."
      />

      <Section title={`Pending advances (${advances.length})`}>
        {advError && (
          <div className="rounded-lg border border-red-200 bg-red-50 text-[var(--color-danger)] px-3 py-2 text-sm mb-2">
            {advError.message}
          </div>
        )}
        {advances.length === 0 ? (
          <Empty>No pending advances.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <Th>Employee</Th>
                <Th className="text-right">Amount</Th>
                <Th>Reason</Th>
                <Th>Requested by</Th>
                <Th className="text-right">Outstanding</Th>
                <Th className="text-right">Monthly salary</Th>
                <Th className="text-right">Decision</Th>
              </tr>
            }
          >
            {advances.map((a) => {
              const worker = one(a.worker) as {
                full_name: string | null;
                monthly_salary: string | null;
                photo_path: string | null;
              } | null;
              const requester = one(a.requester);
              const outstanding = outstandingByWorker.get(a.worker_id) ?? 0;
              return (
                <tr key={a.id} className="align-top">
                  <Td>
                    <div className="flex items-center gap-2">
                      <WorkerAvatar
                        name={worker?.full_name ?? "Unknown"}
                        url={worker?.photo_path ? photoMap[worker.photo_path] : null}
                        size="sm"
                      />
                      <div className="font-medium text-ink">{worker?.full_name ?? "Unknown"}</div>
                    </div>
                  </Td>
                  <Td className="tabular text-right">{money(a.amount)}</Td>
                  <Td>{a.reason}</Td>
                  <Td>
                    <div>{requester?.full_name ?? "—"}</div>
                    <div className="text-muted text-xs">{fmtTs(a.requested_at)}</div>
                  </Td>
                  <Td className="tabular text-right">{money(outstanding)}</Td>
                  <Td className="tabular text-right">{money(worker?.monthly_salary)}</Td>
                  <Td className="text-right">
                    <div className="flex flex-col items-end gap-2">
                      <form action={approveAdvanceAction}>
                        <input type="hidden" name="id" value={a.id} />
                        <Button type="submit" variant="primary">
                          Approve
                        </Button>
                      </form>
                      <RejectButton id={a.id} kind="advance" />
                    </div>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Section>
    </div>
  );
}

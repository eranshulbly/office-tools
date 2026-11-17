import { requireFeature, requireSuiteAccess } from "@/lib/auth";
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
} from "@/components/ui";
import { AdjustmentForm, type WorkerOption } from "./AdjustmentForm";

export const dynamic = "force-dynamic";

type AdjustmentRow = {
  id: string;
  day: string;
  proposed_in: string | null;
  proposed_out: string | null;
  reason: string;
  status: RequestStatus;
  requested_at: string;
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

export default async function AdjustmentsPage() {
  requireSuiteAccess(await requireFeature("adjustments"), "hr");
  const supabase = await createSupabaseServerClient();

  const [workersRes, adjustmentsRes] = await Promise.all([
    supabase
      .from("workers")
      .select("id, full_name, employee_code, designation")
      .eq("is_active", true)
      .order("full_name"),
    supabase
      .from("adjustments")
      .select(
        "id, day, proposed_in, proposed_out, reason, status, requested_at, decision_reason, worker:workers(full_name, employee_code, designation)"
      )
      .order("requested_at", { ascending: false }),
  ]);

  const workers: WorkerOption[] = (workersRes.data ?? []).map((w) => ({
    id: w.id as string,
    label: `${w.full_name} (${w.employee_code})`,
  }));

  const rows = (adjustmentsRes.data ?? []) as unknown as AdjustmentRow[];
  const loadError = workersRes.error?.message ?? adjustmentsRes.error?.message;

  return (
    <div>
      <PageHeader
        title="Adjustments"
        subtitle="Request a forgot-punch correction. Admin approves or rejects."
      />

      {loadError && (
        <div className="mb-6 rounded border border-red-200 bg-red-50 text-[var(--color-danger)] px-3 py-2 text-sm">
          {loadError}
        </div>
      )}

      <Section title="Request adjustment">
        <Card className="p-4 max-w-2xl">
          <AdjustmentForm workers={workers} />
        </Card>
      </Section>

      <Section title="Submitted requests">
        {rows.length === 0 ? (
          <Empty>No adjustment requests yet.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <Th>Employee</Th>
                <Th>Day</Th>
                <Th>Proposed IN</Th>
                <Th>Proposed OUT</Th>
                <Th>Reason</Th>
                <Th>Status</Th>
                <Th>Decision</Th>
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
                <Td>{r.day}</Td>
                <Td>{ts(r.proposed_in)}</Td>
                <Td>{ts(r.proposed_out)}</Td>
                <Td>{r.reason}</Td>
                <Td>
                  <Badge tone={statusTone[r.status]}>{r.status}</Badge>
                </Td>
                <Td>{r.status === "rejected" ? r.decision_reason ?? "—" : "—"}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}

import { requireRole, requireSuiteAccess } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  PageHeader,
  LinkButton,
  Table,
  Th,
  Td,
  Badge,
  Empty,
  FormError,
  money,
} from "@/components/ui";
import Link from "next/link";
import { WorkerCell } from "@/components/WorkerAvatar";
import { signedPhotoUrlMap } from "@/lib/storage";
import type { Worker } from "@/lib/types";

const PAGE_SIZE = 50;

// The workers row now carries an approval_status not yet in the shared Worker
// type; extend it locally so the list can render the pending/rejected badges.
type WorkerRow = Worker & {
  approval_status?: "active" | "pending" | "rejected" | null;
};

/** Status badge shared by both roles (managers never see salary, only status). */
function StatusBadge({ w, today }: { w: WorkerRow; today: string }) {
  if (w.approval_status === "pending") return <Badge tone="warn">Pending</Badge>;
  if (w.approval_status === "rejected") return <Badge tone="neutral">Rejected</Badge>;
  if (w.left_on && w.left_on <= today) return <Badge tone="danger">Left {w.left_on}</Badge>;
  if (w.is_active) return <Badge tone="ok">Active</Badge>;
  return <Badge tone="neutral">Inactive</Badge>;
}

export default async function WorkersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const profile = await requireRole("admin", "manager");
  requireSuiteAccess(profile, "hr");
  const today = new Date().toISOString().slice(0, 10);
  const supabase = await createSupabaseServerClient();

  if (profile.role === "manager") {
    return <ManagerWorkers managerId={profile.id} today={today} />;
  }

  // ── Admin: unchanged behaviour (all workers, paginated) ────────────────────
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const { data, error, count } = await supabase
    .from("workers")
    .select("*", { count: "exact" })
    .order("employee_code")
    .range(from, to);

  const workers = (data ?? []) as WorkerRow[];
  const total = count ?? workers.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const photos = await signedPhotoUrlMap(workers.map((w) => w.photo_path));

  return (
    <div>
      <PageHeader
        title="Employees"
        subtitle={`${total} total${totalPages > 1 ? ` · page ${page} of ${totalPages}` : ""}`}
        actions={
          <LinkButton href="/workers/new" variant="primary">
            New employee
          </LinkButton>
        }
      />

      {error && <FormError message={error.message} />}

      {workers.length === 0 ? (
        <Empty>No employees yet. Add the first one.</Empty>
      ) : (
        <Table
          head={
            <tr>
              <Th>Employee</Th>
              <Th>PIN</Th>
              <Th className="text-right">Monthly salary</Th>
              <Th>Joined</Th>
              <Th>Status</Th>
              <Th></Th>
            </tr>
          }
        >
          {workers.map((w) => (
            <tr key={w.id}>
              <Td>
                <WorkerCell
                  name={w.full_name}
                  code={w.employee_code}
                  url={w.photo_path ? photos[w.photo_path] : null}
                />
              </Td>
              <Td className="tabular">{w.device_user_id ?? "—"}</Td>
              <Td className="tabular text-right">
                {w.monthly_salary == null ? "—" : money(w.monthly_salary)}
              </Td>
              <Td className="tabular">{w.joined_on}</Td>
              <Td>
                <StatusBadge w={w} today={today} />
              </Td>
              <Td className="text-right">
                <LinkButton href={`/workers/${w.id}`} variant="ghost">
                  Edit
                </LinkButton>
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 text-sm">
          {page > 1 ? (
            <Link href={`/workers?page=${page - 1}`} className="text-brand hover:underline">
              ← Previous
            </Link>
          ) : (
            <span className="text-muted">← Previous</span>
          )}
          <span className="text-muted">
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? (
            <Link href={`/workers?page=${page + 1}`} className="text-brand hover:underline">
              Next →
            </Link>
          ) : (
            <span className="text-muted">Next →</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Manager view: only workers in the manager's own groups; no salary column. */
async function ManagerWorkers({ managerId, today }: { managerId: string; today: string }) {
  const supabase = await createSupabaseServerClient();

  // The manager's own groups (id → name).
  const { data: mga } = await supabase
    .from("manager_group_access")
    .select("group_id, worker_groups(id, name)")
    .eq("manager_id", managerId);

  const groupName = new Map<string, string>();
  for (const r of mga ?? []) {
    const g = r.worker_groups as unknown as { id: string; name: string } | null;
    if (g) groupName.set(g.id, g.name);
  }
  const groupIds = Array.from(groupName.keys());

  let workers: WorkerRow[] = [];
  let error: string | undefined;
  if (groupIds.length > 0) {
    const { data, error: err } = await supabase
      .from("workers")
      .select("*")
      .in("group_id", groupIds)
      .order("employee_code");
    workers = (data ?? []) as WorkerRow[];
    error = err?.message;
  }

  const photos = await signedPhotoUrlMap(workers.map((w) => w.photo_path));

  return (
    <div>
      <PageHeader
        title="Employees"
        subtitle={`${workers.length} in your groups`}
        actions={
          <LinkButton href="/workers/new" variant="primary">
            New employee
          </LinkButton>
        }
      />

      <p className="mb-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-[var(--color-warn)]">
        New employees and edits you submit need admin approval before they take effect.
      </p>

      {error && <FormError message={error} />}

      {workers.length === 0 ? (
        <Empty>No employees in your groups yet. Add the first one.</Empty>
      ) : (
        <Table
          head={
            <tr>
              <Th>Employee</Th>
              <Th>Phone</Th>
              <Th>Group</Th>
              <Th>Status</Th>
              <Th></Th>
            </tr>
          }
        >
          {workers.map((w) => (
            <tr key={w.id}>
              <Td>
                <WorkerCell
                  name={w.full_name}
                  code={w.employee_code}
                  url={w.photo_path ? photos[w.photo_path] : null}
                />
              </Td>
              <Td className="tabular">{w.phone ?? "—"}</Td>
              <Td>{w.group_id ? groupName.get(w.group_id) ?? "—" : "—"}</Td>
              <Td>
                <StatusBadge w={w} today={today} />
              </Td>
              <Td className="text-right">
                <LinkButton href={`/workers/${w.id}`} variant="ghost">
                  Propose edit
                </LinkButton>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

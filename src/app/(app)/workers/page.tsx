import { requireFeature, requireSuiteAccess } from "@/lib/auth";
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

/**
 * Match an employee against a typed query.
 *
 * Applied in TypeScript rather than SQL because matching across several
 * columns needs an OR, which the query builder does not express, and the
 * roster is small enough that the page can hold all of it. Same approach as
 * the candidate search. Past a few thousand employees this should become a
 * real full-text index rather than a bigger fetch.
 *
 * Salary is deliberately NOT searchable: non-admins never receive the column,
 * so including it would make results differ by role in a confusing way — and
 * it would let someone probe for a value they are not allowed to read.
 */
function matchesSearch(w: WorkerRow, needle: string): boolean {
  if (!needle) return true;
  return [w.full_name, w.full_name_only, w.employee_code, w.designation, w.phone]
    .some((f) => (f ?? "").toLowerCase().includes(needle));
}

/** The search box. Plain GET so it survives a reload and needs no JavaScript. */
function SearchBox({ q, count }: { q: string; count: number }) {
  return (
    <form method="GET" className="mb-3 flex flex-wrap items-center gap-2">
      <input
        type="search"
        name="q"
        defaultValue={q}
        placeholder="Search by name, code, designation or phone…"
        aria-label="Search employees"
        className="w-full max-w-md rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
      />
      <button
        type="submit"
        className="rounded-lg bg-[var(--color-brand)] px-3.5 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-strong)]"
      >
        Search
      </button>
      {q && (
        <>
          <LinkButton href="/workers" variant="ghost">
            Clear
          </LinkButton>
          <span className="text-muted text-sm">
            {count} {count === 1 ? "match" : "matches"} for &ldquo;{q}&rdquo;
          </span>
        </>
      )}
    </form>
  );
}

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
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const profile = await requireFeature("workers");
  requireSuiteAccess(profile, "hr");
  const today = new Date().toISOString().slice(0, 10);
  const supabase = await createSupabaseServerClient();

  /**
   * Everyone who is not an admin gets the restricted view.
   *
   * This used to read `role === "manager"`, so when ops_manager_hr was added
   * it fell through to the ADMIN branch and saw salaries. Testing for admin
   * instead fails closed: a role added later gets the restricted view until
   * someone deliberately decides otherwise.
   *
   * ops_manager_hr is not scoped to groups the way a manager is — HR covers
   * everyone — so they see the whole roster, minus the columns the query
   * builder now withholds from non-admins.
   */
  const { page: pageParam, q: rawQ } = await searchParams;
  const q = (rawQ ?? "").trim();
  const needle = q.toLowerCase();

  if (profile.role !== "admin") {
    return (
      <ManagerWorkers
        managerId={profile.id}
        today={today}
        allGroups={profile.role === "ops_manager_hr"}
        q={q}
        needle={needle}
      />
    );
  }

  // ── Admin: all workers, searchable, paginated ─────────────────────────────
  const page = Math.max(1, Number(pageParam) || 1);

  // Fetched whole and paged in memory, because the search has to run across
  // the entire roster — paging in SQL first would only ever search one page.
  const { data, error } = await supabase
    .from("workers")
    .select("*")
    .order("employee_code");

  const all = (data ?? []) as WorkerRow[];
  const matched = all.filter((w) => matchesSearch(w, needle));

  const total = matched.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages); // a narrowed search can orphan a page
  const from = (safePage - 1) * PAGE_SIZE;
  const workers = matched.slice(from, from + PAGE_SIZE);
  const photos = await signedPhotoUrlMap(workers.map((w) => w.photo_path));
  const pageHref = (p: number) =>
    `/workers?page=${p}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  return (
    <div>
      <PageHeader
        title="Employees"
        subtitle={`${total} ${q ? "matching" : "total"}${
          totalPages > 1 ? ` · page ${safePage} of ${totalPages}` : ""
        }`}
        actions={
          <LinkButton href="/workers/new" variant="primary">
            New employee
          </LinkButton>
        }
      />

      {error && <FormError message={error.message} />}

      <SearchBox q={q} count={total} />

      {workers.length === 0 ? (
        <Empty>
          {q ? `No employee matches “${q}”.` : "No employees yet. Add the first one."}
        </Empty>
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
                  designation={w.designation}
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
          {safePage > 1 ? (
            <Link href={pageHref(safePage - 1)} className="text-brand hover:underline">
              ← Previous
            </Link>
          ) : (
            <span className="text-muted">← Previous</span>
          )}
          <span className="text-muted">
            Page {safePage} of {totalPages}
          </span>
          {safePage < totalPages ? (
            <Link href={pageHref(safePage + 1)} className="text-brand hover:underline">
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
async function ManagerWorkers({
  managerId,
  today,
  allGroups = false,
  q = "",
  needle = "",
}: {
  managerId: string;
  today: string;
  /** HR roles cover the whole roster; a manager sees only their own groups. */
  allGroups?: boolean;
  q?: string;
  needle?: string;
}) {
  const supabase = await createSupabaseServerClient();

  const groupName = new Map<string, string>();
  if (allGroups) {
    const { data: gs } = await supabase.from("worker_groups").select("id, name");
    for (const g of (gs ?? []) as { id: string; name: string }[]) {
      groupName.set(g.id, g.name);
    }
  } else {
    // The manager's own groups (id → name).
    const { data: mga } = await supabase
      .from("manager_group_access")
      .select("group_id, worker_groups(id, name)")
      .eq("manager_id", managerId);
    for (const r of mga ?? []) {
      const g = r.worker_groups as unknown as { id: string; name: string } | null;
      if (g) groupName.set(g.id, g.name);
    }
  }
  const groupIds = Array.from(groupName.keys());

  let workers: WorkerRow[] = [];
  let error: string | undefined;
  // Columns are listed rather than "*" so this page states what it needs.
  // The builder withholds salary from non-admins regardless; naming the
  // columns means a reader can see that without having to know the rule.
  const COLS =
    "id, employee_code, full_name, designation, phone, group_id, photo_path, " +
    "is_active, left_on, approval_status";
  if (allGroups) {
    const { data, error: err } = await supabase
      .from("workers")
      .select(COLS)
      .order("employee_code");
    workers = (data ?? []) as WorkerRow[];
    error = err?.message;
  } else if (groupIds.length > 0) {
    const { data, error: err } = await supabase
      .from("workers")
      .select(COLS)
      .in("group_id", groupIds)
      .order("employee_code");
    workers = (data ?? []) as WorkerRow[];
    error = err?.message;
  }

  const matched = workers.filter((w) => matchesSearch(w, needle));
  const photos = await signedPhotoUrlMap(matched.map((w) => w.photo_path));

  return (
    <div>
      <PageHeader
        title="Employees"
        subtitle={
          q
            ? `${matched.length} matching`
            : allGroups
              ? `${workers.length} employees`
              : `${workers.length} in your groups`
        }
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

      <SearchBox q={q} count={matched.length} />

      {matched.length === 0 ? (
        <Empty>
          {q
            ? `No employee matches “${q}”.`
            : allGroups
              ? "No employees yet. Add the first one."
              : "No employees in your groups yet. Add the first one."}
        </Empty>
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
          {matched.map((w) => (
            <tr key={w.id}>
              <Td>
                <WorkerCell
                  name={w.full_name}
                  code={w.employee_code}
                  designation={w.designation}
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

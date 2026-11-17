import { requireFeature } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageHeader, Section, Card, Table, Th, Td, Badge, Button, Empty } from "@/components/ui";
import { WorkerAvatar, WorkerCell } from "@/components/WorkerAvatar";
import { signedPhotoUrlMap, signedIdProofUrl } from "@/lib/storage";
import { approveAdjustmentAction, approveLateReviewAction } from "./actions";
import { RejectButton } from "./RejectButton";
import { RejectLateButton } from "./RejectLateButton";
import { ApproveWorkerForm } from "./ApproveWorkerForm";
import { DecideEditButtons } from "./DecideEditButtons";

type LateRow = {
  worker_id: string;
  day: string;
  first_in: string | null;
  last_out: string | null;
  worked_hours: number | string | null;
  workers: { full_name: string; employee_code: string; photo_path: string | null } | null;
};

function fmtTime(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

/**
 * HR → Approvals: the pending forgot-punch adjustment queue (spec §3.5). Shows
 * the per-worker manual-entry count for the relevant payroll period as the
 * primary fraud control (§3.5). Advance approvals live under Payroll.
 */

export const dynamic = "force-dynamic";

function one<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/** Payroll period containing `day` = its calendar month (1st → last day). */
function periodFor(day: string): { start: string; end: string } {
  const [y, m] = day.split("-").map(Number); // m is 1-based
  const pad = (n: number) => String(n).padStart(2, "0");
  const last = new Date(y, m, 0).getDate(); // last day of month m
  return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(last)}` };
}

type Named = { full_name: string | null } | null;

type AdjRow = {
  id: string;
  worker_id: string;
  day: string;
  proposed_in: string | null;
  proposed_out: string | null;
  reason: string;
  requested_at: string;
  worker:
    | { full_name: string | null; employee_code: string | null; photo_path: string | null }
    | Named;
  requester: Named;
};

function fmtTs(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-IN");
}

// ── New-worker requests (manager submits → admin adds pay/bank & activates) ───

type GroupName = { name: string | null } | null;

type NewWorkerRow = {
  id: string;
  full_name: string | null;
  employee_code: string | null;
  device_user_id: number | null;
  phone: string | null;
  joined_on: string | null;
  photo_path: string | null;
  id_proof_path: string | null;
  group_id: string | null;
  worker_groups: GroupName | GroupName[];
};

// ── Manager-proposed edits to existing workers ───────────────────────────────

type EditPayload = Partial<{
  full_name: string | null;
  employee_code: string | null;
  device_user_id: number | null;
  phone: string | null;
  group_id: string | null;
  joined_on: string | null;
  left_on: string | null;
  is_active: boolean | null;
}>;

type EditWorker = {
  full_name: string | null;
  employee_code: string | null;
  group_id: string | null;
  phone: string | null;
  joined_on: string | null;
  left_on: string | null;
  is_active: boolean | null;
  device_user_id: number | null;
};

type EditRow = {
  id: string;
  worker_id: string;
  payload: EditPayload | null;
  requested_at: string;
  worker: EditWorker | EditWorker[] | null;
};

const EDIT_FIELD_LABELS: Record<string, string> = {
  full_name: "Name",
  employee_code: "Employee code",
  device_user_id: "Device PIN",
  phone: "Phone",
  group_id: "Group",
  joined_on: "Joined on",
  left_on: "Left on",
  is_active: "Active",
};
// Only these keys are ever proposed; anything else in the payload is ignored.
const EDIT_FIELD_ORDER = Object.keys(EDIT_FIELD_LABELS);

function fmtEditValue(
  key: string,
  value: unknown,
  groupNames: Map<string, string>
): string {
  if (value == null || value === "") return "—";
  if (key === "group_id") return groupNames.get(String(value)) ?? String(value);
  if (key === "is_active") return value ? "Yes" : "No";
  return String(value);
}

export default async function ApprovalsPage() {
  await requireFeature("approvals");
  const supabase = await createSupabaseServerClient();

  const { data: settingsRows } = await supabase
    .from("settings")
    .select("key, value")
    .in("key", ["manual_entry_alert_threshold"]);

  const settings = new Map<string, unknown>(
    (settingsRows ?? []).map((r) => [r.key as string, r.value] as [string, unknown])
  );
  const threshold = Number(settings.get("manual_entry_alert_threshold") ?? 3);

  const { data: adjData, error: adjError } = await supabase
    .from("adjustments")
    .select(
      "id, worker_id, day, proposed_in, proposed_out, reason, requested_at, " +
        "worker:workers(full_name, employee_code, designation, photo_path), " +
        "requester:profiles!requested_by(full_name)"
    )
    .eq("status", "pending")
    .order("requested_at", { ascending: true });

  const adjustments = (adjData ?? []) as unknown as AdjRow[];

  const adjWorkerIds = [...new Set(adjustments.map((a) => a.worker_id))];
  let approvedAdj: { worker_id: string; day: string }[] = [];
  if (adjWorkerIds.length) {
    const { data } = await supabase
      .from("adjustments")
      .select("worker_id, day")
      .eq("status", "approved")
      .in("worker_id", adjWorkerIds);
    approvedAdj = (data ?? []) as { worker_id: string; day: string }[];
  }

  function approvedCountInPeriod(workerId: string, day: string): number {
    const { start, end } = periodFor(day);
    return approvedAdj.filter((a) => a.worker_id === workerId && a.day >= start && a.day <= end).length;
  }

  // Held late-arrival days (after the 10 PM cutoff) — part of the same queue.
  const { data: lateData } = await supabase
    .from("attendance_days")
    .select("worker_id, day, first_in, last_out, worked_hours, workers(full_name, employee_code, designation, photo_path)")
    .eq("status", "late_review")
    .order("day")
    .order("worker_id");
  const lateRows = (lateData ?? []) as unknown as LateRow[];

  // Pending NEW workers submitted by managers (need salary/bank + activation).
  const { data: newWorkerData, error: newWorkerError } = await supabase
    .from("workers")
    .select(
      "id, full_name, employee_code, designation, device_user_id, phone, joined_on, photo_path, id_proof_path, group_id, " +
        "worker_groups(name)"
    )
    .eq("approval_status", "pending")
    .order("employee_code");
  const newWorkers = (newWorkerData ?? []) as unknown as NewWorkerRow[];

  // Sign each id-proof (sensitive → not batched/cached; small admin queue).
  const idProofEntries = await Promise.all(
    newWorkers
      .filter((w) => w.id_proof_path)
      .map(
        async (w) => [w.id_proof_path as string, await signedIdProofUrl(w.id_proof_path)] as const
      )
  );
  const idProofMap = new Map<string, string | null>(idProofEntries);

  // Pending manager-proposed EDITS to existing workers.
  const { data: editData, error: editError } = await supabase
    .from("worker_edit_requests")
    .select(
      "id, worker_id, payload, requested_at, " +
        "worker:workers(full_name, employee_code, group_id, phone, joined_on, left_on, is_active, device_user_id)"
    )
    .eq("status", "pending")
    .order("requested_at", { ascending: true });
  const editRows = (editData ?? []) as unknown as EditRow[];

  // Resolve every referenced group id (current worker groups + proposed ones) to
  // a name, in one query, so the diff shows group names rather than uuids.
  const groupIds = new Set<string>();
  for (const w of newWorkers) if (w.group_id) groupIds.add(w.group_id);
  for (const r of editRows) {
    const w = one(r.worker) as EditWorker | null;
    if (w?.group_id) groupIds.add(w.group_id);
    const pg = r.payload?.group_id;
    if (pg) groupIds.add(String(pg));
  }
  const groupNames = new Map<string, string>();
  if (groupIds.size > 0) {
    const { data: groupData } = await supabase
      .from("worker_groups")
      .select("id, name")
      .in("id", [...groupIds]);
    for (const g of (groupData ?? []) as { id: string; name: string | null }[]) {
      if (g.name) groupNames.set(g.id, g.name);
    }
  }

  const photoMap = await signedPhotoUrlMap([
    ...adjustments.map((a) => {
      const w = one(a.worker) as { photo_path?: string | null } | null;
      return w?.photo_path;
    }),
    ...lateRows.map((r) => r.workers?.photo_path),
    ...newWorkers.map((w) => w.photo_path),
  ]);

  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle="New employee requests, employee changes, attendance adjustments, and after-10 PM late arrivals. Rejections require a reason."
      />

      <Section title={`Pending adjustments (${adjustments.length})`}>
        {adjError && (
          <div className="rounded-lg border border-red-200 bg-red-50 text-[var(--color-danger)] px-3 py-2 text-sm mb-2">
            {adjError.message}
          </div>
        )}
        {adjustments.length === 0 ? (
          <Empty>No pending adjustments.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <Th>Employee</Th>
                <Th>Day</Th>
                <Th>Proposed in</Th>
                <Th>Proposed out</Th>
                <Th>Reason</Th>
                <Th>Requested by</Th>
                <Th>Period manual entries</Th>
                <Th className="text-right">Decision</Th>
              </tr>
            }
          >
            {adjustments.map((a) => {
              const worker = one(a.worker) as {
                full_name: string | null;
                employee_code: string | null;
                photo_path: string | null;
              } | null;
              const requester = one(a.requester);
              const count = approvedCountInPeriod(a.worker_id, a.day);
              const over = count > threshold;
              return (
                <tr key={a.id} className="align-top">
                  <Td>
                    <div className="flex items-center gap-2">
                      <WorkerAvatar
                        name={worker?.full_name ?? "Unknown"}
                        url={worker?.photo_path ? photoMap[worker.photo_path] : null}
                        size="sm"
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-ink">{worker?.full_name ?? "Unknown"}</div>
                        {worker?.employee_code && (
                          <div className="text-muted text-xs">{worker.employee_code}</div>
                        )}
                      </div>
                    </div>
                  </Td>
                  <Td className="tabular">{a.day}</Td>
                  <Td className="tabular">{fmtTs(a.proposed_in)}</Td>
                  <Td className="tabular">{fmtTs(a.proposed_out)}</Td>
                  <Td>{a.reason}</Td>
                  <Td>
                    <div>{requester?.full_name ?? "—"}</div>
                    <div className="text-muted text-xs">{fmtTs(a.requested_at)}</div>
                  </Td>
                  <Td>
                    <Badge tone={over ? "danger" : "neutral"}>{count} approved</Badge>
                    {over && (
                      <div className="text-[var(--color-danger)] text-xs mt-1">
                        Over threshold ({threshold})
                      </div>
                    )}
                  </Td>
                  <Td className="text-right">
                    <div className="flex flex-col items-end gap-2">
                      <form action={approveAdjustmentAction}>
                        <input type="hidden" name="id" value={a.id} />
                        <Button type="submit" variant="primary">
                          Approve
                        </Button>
                      </form>
                      <RejectButton id={a.id} kind="adjustment" />
                    </div>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Section>

      <Section title={`Late arrivals — after 10 PM (${lateRows.length})`}>
        {lateRows.length === 0 ? (
          <Empty>No late arrivals awaiting review.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <Th>Employee</Th>
                <Th>Day</Th>
                <Th>First in</Th>
                <Th>Last out</Th>
                <Th className="text-right">Hours</Th>
                <Th className="text-right">Decision</Th>
              </tr>
            }
          >
            {lateRows.map((r) => (
              <tr key={`${r.worker_id}-${r.day}`} className="align-top">
                <Td>
                  <WorkerCell
                    name={r.workers?.full_name ?? "—"}
                    code={r.workers?.employee_code}
                    url={r.workers?.photo_path ? photoMap[r.workers.photo_path] : null}
                    size="sm"
                  />
                </Td>
                <Td className="tabular">
                  <div className="flex items-center gap-2">
                    <span>{r.day}</span>
                    <Badge tone="danger">Late</Badge>
                  </div>
                </Td>
                <Td className="tabular">{fmtTime(r.first_in)}</Td>
                <Td className="tabular">{fmtTime(r.last_out)}</Td>
                <Td className="tabular text-right">
                  {r.worked_hours != null ? Number(r.worked_hours).toFixed(2) : "—"}
                </Td>
                <Td className="text-right">
                  <div className="flex items-start justify-end gap-2">
                    <form action={approveLateReviewAction}>
                      <input type="hidden" name="worker_id" value={r.worker_id} />
                      <input type="hidden" name="day" value={r.day} />
                      <Button type="submit" variant="primary">
                        Approve
                      </Button>
                    </form>
                    <RejectLateButton workerId={r.worker_id} day={r.day} />
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title={`New employee requests (${newWorkers.length})`}>
        {newWorkerError && (
          <div className="rounded-lg border border-red-200 bg-red-50 text-[var(--color-danger)] px-3 py-2 text-sm mb-2">
            {newWorkerError.message}
          </div>
        )}
        {newWorkers.length === 0 ? (
          <Empty>No new employee requests.</Empty>
        ) : (
          <div className="flex flex-col gap-3">
            {newWorkers.map((w) => {
              const group = one(w.worker_groups) as { name: string | null } | null;
              const idProofUrl = w.id_proof_path ? idProofMap.get(w.id_proof_path) : null;
              return (
                <Card key={w.id} className="p-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch lg:justify-between">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <WorkerAvatar
                        name={w.full_name ?? "Unknown"}
                        url={w.photo_path ? photoMap[w.photo_path] : null}
                        size="lg"
                      />
                      <div className="min-w-0 text-sm">
                        <div className="font-medium text-ink">{w.full_name ?? "Unknown"}</div>
                        {w.employee_code && (
                          <div className="text-muted text-xs">{w.employee_code}</div>
                        )}
                        <dl className="mt-3 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
                          <dt className="text-muted">Device PIN</dt>
                          <dd className="tabular text-ink">{w.device_user_id ?? "—"}</dd>
                          <dt className="text-muted">Group</dt>
                          <dd className="text-ink">{group?.name ?? "—"}</dd>
                          <dt className="text-muted">Phone</dt>
                          <dd className="text-ink">{w.phone ?? "—"}</dd>
                          <dt className="text-muted">Joined on</dt>
                          <dd className="tabular text-ink">{w.joined_on ?? "—"}</dd>
                          <dt className="text-muted">ID proof</dt>
                          <dd>
                            {w.id_proof_path ? (
                              idProofUrl ? (
                                <a
                                  href={idProofUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-brand underline"
                                >
                                  View
                                </a>
                              ) : (
                                <span className="text-muted">unavailable</span>
                              )
                            ) : (
                              <span className="text-muted">—</span>
                            )}
                          </dd>
                        </dl>
                      </div>
                    </div>
                    <div className="lg:w-72 lg:shrink-0 lg:border-l lg:border-line lg:pl-4">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-faint mb-2">
                        Add salary &amp; approve
                      </div>
                      <ApproveWorkerForm workerId={w.id} />
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </Section>

      <Section title={`Employee changes (${editRows.length})`}>
        {editError && (
          <div className="rounded-lg border border-red-200 bg-red-50 text-[var(--color-danger)] px-3 py-2 text-sm mb-2">
            {editError.message}
          </div>
        )}
        {editRows.length === 0 ? (
          <Empty>No pending employee changes.</Empty>
        ) : (
          <div className="flex flex-col gap-3">
            {editRows.map((r) => {
              const worker = one(r.worker) as EditWorker | null;
              const payload = r.payload ?? {};
              const current = (worker ?? {}) as Record<string, unknown>;
              const keys = EDIT_FIELD_ORDER.filter((k) => k in payload);
              return (
                <Card key={r.id} className="p-4">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium text-ink">{worker?.full_name ?? "Unknown"}</span>
                        {worker?.employee_code && (
                          <span className="text-muted text-xs">{worker.employee_code}</span>
                        )}
                      </div>
                      <div className="text-muted text-xs mt-0.5">Requested {fmtTs(r.requested_at)}</div>

                      {keys.length === 0 ? (
                        <div className="text-muted text-xs mt-3">No fields changed.</div>
                      ) : (
                        <div className="mt-3 rounded-lg border border-line bg-[var(--color-surface-2)] p-3">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-faint mb-2">
                            Proposed changes ({keys.length})
                          </div>
                          <div className="space-y-1.5">
                            {keys.map((k) => (
                              <div key={k} className="grid grid-cols-[6.5rem_1fr] items-baseline gap-3 text-sm">
                                <span className="text-muted text-xs">{EDIT_FIELD_LABELS[k]}</span>
                                <span className="flex flex-wrap items-baseline gap-1.5">
                                  <span className="text-faint line-through">
                                    {fmtEditValue(k, current[k], groupNames)}
                                  </span>
                                  <span className="text-faint">→</span>
                                  <span className="text-ink font-medium">
                                    {fmtEditValue(k, (payload as Record<string, unknown>)[k], groupNames)}
                                  </span>
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="sm:w-56 sm:shrink-0">
                      <DecideEditButtons requestId={r.id} />
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}

import { notFound } from "next/navigation";
import { requireRole, requireSuiteAccess } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageHeader, LinkButton, Card, Badge, Section } from "@/components/ui";
import { signedPhotoUrl, signedIdProofUrl } from "@/lib/storage";
import type { Worker } from "@/lib/types";
import { WorkerForm } from "../WorkerForm";
import { ManagerEditForm } from "../ManagerEditForm";

type EditRequestRow = {
  id: string;
  payload: Record<string, string | boolean>;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  decided_at: string | null;
  decision_reason: string | null;
};

const REQ_LABEL: Record<EditRequestRow["status"], string> = {
  pending: "Pending approval",
  approved: "Approved",
  rejected: "Rejected",
};
const REQ_TONE: Record<EditRequestRow["status"], "warn" | "ok" | "danger"> = {
  pending: "warn",
  approved: "ok",
  rejected: "danger",
};

const FIELD_LABEL: Record<string, string> = {
  full_name: "Full name",
  employee_code: "Employee code",
  device_user_id: "Device PIN",
  group_id: "Group",
  phone: "Phone",
  joined_on: "Joined on",
  left_on: "Left on",
  is_active: "Status",
};

/** Label + new-value pairs for a change request's payload (only changed fields). */
function changeEntries(
  payload: Record<string, string | boolean>,
  groupName: Map<string, string>
): { label: string; value: string }[] {
  return Object.entries(payload).map(([k, v]) => {
    const label = FIELD_LABEL[k] ?? k;
    let value: string;
    if (k === "is_active") value = v === true || v === "true" ? "Active" : "Inactive";
    else if (k === "group_id") value = v ? groupName.get(String(v)) ?? String(v) : "— none —";
    else if (v === "") value = "cleared";
    else value = String(v);
    return { label, value };
  });
}

export default async function EditWorkerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const profile = await requireRole("admin", "manager");
  requireSuiteAccess(profile, "hr");
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  if (profile.role === "manager") {
    // Manager: they may only propose edits to workers in their own groups, but
    // may re-assign to ANY group (the target dropdown lists every group).
    const [{ data: workerData }, { data: mga }, { data: allGroupData }, { data: myReqData }] = await Promise.all([
      supabase.from("workers").select("*").eq("id", id).single(),
      supabase
        .from("manager_group_access")
        .select("group_id")
        .eq("manager_id", profile.id),
      supabase.from("worker_groups").select("id, name").order("name"),
      // This manager's own change requests for this employee (any status).
      supabase
        .from("worker_edit_requests")
        .select("id, payload, status, requested_at, decided_at, decision_reason")
        .eq("worker_id", id)
        .eq("requested_by", profile.id)
        .order("requested_at", { ascending: false }),
    ]);

    if (!workerData) notFound();
    const worker = workerData as Worker;

    // Guard (which workers are editable): the manager's own groups.
    const ownGroupIds = new Set((mga ?? []).map((r) => r.group_id as string));
    if (!worker.group_id || !ownGroupIds.has(worker.group_id)) {
      notFound();
    }

    // Dropdown options: every group (a manager may propose any target group).
    const managerGroups = (allGroupData ?? []) as { id: string; name: string }[];
    const groupName = new Map(managerGroups.map((g) => [g.id, g.name]));
    const myRequests = (myReqData ?? []) as EditRequestRow[];

    return (
      <div>
        <PageHeader
          title={worker.full_name}
          subtitle={`Employee ${worker.employee_code}`}
          actions={<LinkButton href="/workers">Back to employees</LinkButton>}
        />
        <Card className="p-5 max-w-2xl">
          <p className="mb-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-[var(--color-warn)]">
            Edits you submit need admin approval before they take effect.
          </p>
          <ManagerEditForm worker={worker} groups={managerGroups} />
        </Card>

        {myRequests.length > 0 && (
          <Section title={`Your change requests (${myRequests.length})`}>
            <p className="text-xs text-muted -mt-1 mb-3">Only the fields you change are submitted.</p>
            <div className="flex flex-col gap-3">
              {myRequests.map((r) => {
                const entries = changeEntries(r.payload, groupName);
                return (
                  <Card key={r.id} className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-muted text-xs">
                          Requested {new Date(r.requested_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                        </div>
                        {entries.length > 0 && (
                          <div className="mt-2 rounded-lg border border-line bg-[var(--color-surface-2)] p-3">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-faint mb-2">
                              Proposed changes ({entries.length})
                            </div>
                            <div className="space-y-1.5">
                              {entries.map((c, i) => (
                                <div key={i} className="grid grid-cols-[7rem_1fr] items-baseline gap-3 text-sm">
                                  <span className="text-muted text-xs">{c.label}</span>
                                  <span className="text-ink font-medium">{c.value}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {r.status === "rejected" && r.decision_reason && (
                          <p className="mt-2 text-xs text-[var(--color-danger)]">Reason: {r.decision_reason}</p>
                        )}
                      </div>
                      <Badge tone={REQ_TONE[r.status]}>{REQ_LABEL[r.status]}</Badge>
                    </div>
                  </Card>
                );
              })}
            </div>
          </Section>
        )}
      </div>
    );
  }

  // Admin: unchanged behaviour (full direct control, incl. salary + bank).
  const [{ data }, { data: groupData }, { data: bankData }] = await Promise.all([
    supabase.from("workers").select("*").eq("id", id).single(),
    supabase.from("worker_groups").select("id, name").order("name"),
    supabase.from("worker_bank_details").select("bank_account, bank_ifsc").eq("worker_id", id).maybeSingle(),
  ]);

  if (!data) notFound();
  const worker = data as Worker;
  const groups = (groupData ?? []) as { id: string; name: string }[];
  const bank = (bankData ?? null) as { bank_account: string | null; bank_ifsc: string | null } | null;

  // Admin views this page, so both signed URLs are permitted by storage RLS.
  const photoUrl = await signedPhotoUrl(worker.photo_path);
  const idProofUrl = await signedIdProofUrl(worker.id_proof_path);

  return (
    <div>
      <PageHeader
        title={worker.full_name}
        subtitle={`Employee ${worker.employee_code}`}
        actions={<LinkButton href="/workers">Back to employees</LinkButton>}
      />

      <Card className="p-5 max-w-2xl">
        <p className="mb-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-[var(--color-warn)]">
          Changing the salary affects only <strong>future</strong> payroll runs.
          Past runs use the <code>salary_snapshot</code> captured when they were
          computed and are not altered.
        </p>
        <WorkerForm mode="edit" worker={worker} photoUrl={photoUrl} hasIdProof={!!worker.id_proof_path} groups={groups} bank={bank} />

        {idProofUrl && (
          <p className="mt-4 text-sm">
            <a
              href={idProofUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand hover:underline"
            >
              View current identity proof ↗
            </a>{" "}
            <span className="text-muted">(admin-only, opens in a new tab)</span>
          </p>
        )}
      </Card>
    </div>
  );
}

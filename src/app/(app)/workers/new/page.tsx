import { requireRole, requireSuiteAccess } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageHeader, LinkButton, Card } from "@/components/ui";
import { WorkerForm } from "../WorkerForm";
import { ManagerWorkerForm } from "../ManagerWorkerForm";

export default async function NewWorkerPage() {
  const profile = await requireRole("admin", "manager");
  requireSuiteAccess(profile, "hr");
  const supabase = await createSupabaseServerClient();

  if (profile.role === "manager") {
    // A manager may propose ANY group (the submission is pending admin approval;
    // group segregation applies at disbursement / confidential data, not entry).
    const { data: groupData } = await supabase
      .from("worker_groups")
      .select("id, name")
      .order("name");
    const managerGroups = (groupData ?? []) as { id: string; name: string }[];

    return (
      <div>
        <PageHeader
          title="New employee"
          subtitle="Submit an employee for admin approval"
          actions={<LinkButton href="/workers">Back to employees</LinkButton>}
        />
        <Card className="p-5 max-w-2xl">
          <p className="mb-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-[var(--color-warn)]">
            New employees you submit need admin approval before they take effect.
            The admin adds the salary and bank details on approval.
          </p>
          <ManagerWorkerForm groups={managerGroups} />
        </Card>
      </div>
    );
  }

  // Admin: unchanged behaviour.
  const { data: groupData } = await supabase
    .from("worker_groups")
    .select("id, name")
    .order("name");
  const groups = (groupData ?? []) as { id: string; name: string }[];

  return (
    <div>
      <PageHeader
        title="New employee"
        subtitle="Add an employee to payroll"
        actions={<LinkButton href="/workers">Back to employees</LinkButton>}
      />
      <Card className="p-5 max-w-2xl">
        <WorkerForm mode="create" groups={groups} />
      </Card>
    </div>
  );
}

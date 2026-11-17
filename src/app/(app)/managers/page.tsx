import { requireFeature } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageHeader, Card, Section, Badge, Empty } from "@/components/ui";
import type { WorkerGroup } from "@/lib/types";
import { CreateManagerForm } from "./CreateManagerForm";
import { ManagerGroupsForm } from "./ManagerGroupsForm";

type ManagerRow = { id: string; full_name: string };
type AccessRow = { manager_id: string; group_id: string };

export default async function ManagersPage() {
  await requireFeature("managers");

  const supabase = await createSupabaseServerClient();
  const [{ data: managerData }, { data: groupData }, { data: accessData }] =
    await Promise.all([
      supabase
        .from("profiles")
        .select("id, full_name")
        .eq("role", "manager")
        .order("full_name"),
      supabase.from("worker_groups").select("id, name, created_at").order("name"),
      supabase.from("manager_group_access").select("manager_id, group_id"),
    ]);

  const managers = (managerData ?? []) as ManagerRow[];
  const groups = (groupData ?? []) as WorkerGroup[];
  const access = (accessData ?? []) as AccessRow[];

  const accessByManager = new Map<string, string[]>();
  for (const a of access) {
    const list = accessByManager.get(a.manager_id) ?? [];
    list.push(a.group_id);
    accessByManager.set(a.manager_id, list);
  }

  return (
    <div>
      <PageHeader
        title="Managers"
        subtitle={`${managers.length} manager(s) · ${groups.length} group(s)`}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <Section title="New manager">
            <Card className="p-5">
              <CreateManagerForm />
            </Card>
          </Section>
        </div>

        <div className="lg:col-span-2">
          <Section title="Disbursal access">
            {managers.length === 0 ? (
              <Empty>No managers yet. Create the first one.</Empty>
            ) : (
              <div className="space-y-5">
                {managers.map((m) => {
                  const selected = accessByManager.get(m.id) ?? [];
                  return (
                    <Card key={m.id} className="p-5">
                      <div className="flex items-center gap-2 mb-3">
                        <span className="font-semibold text-ink">
                          {m.full_name || "(no name)"}
                        </span>
                        <Badge tone={selected.length ? "info" : "neutral"}>
                          {selected.length} group(s)
                        </Badge>
                      </div>
                      <ManagerGroupsForm
                        managerId={m.id}
                        groups={groups}
                        selected={selected}
                      />
                    </Card>
                  );
                })}
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

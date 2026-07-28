import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageHeader, Card, Section, Badge, Empty, Table, Th, Td } from "@/components/ui";
import type { WorkerGroup } from "@/lib/types";
import { CreateGroupForm } from "./CreateGroupForm";
import { DeleteGroupButton } from "./DeleteGroupButton";
import { RemoveWorkerButton } from "./RemoveWorkerButton";

type GroupWorker = {
  id: string;
  full_name: string;
  employee_code: string;
  group_id: string | null;
};

export default async function GroupsPage() {
  await requireRole("admin");

  const supabase = await createSupabaseServerClient();
  const [{ data: groupData }, { data: workerData }] = await Promise.all([
    supabase.from("worker_groups").select("id, name, created_at").order("name"),
    supabase
      .from("workers")
      .select("id, full_name, employee_code, group_id")
      .order("employee_code"),
  ]);

  const groups = (groupData ?? []) as WorkerGroup[];
  const workers = (workerData ?? []) as GroupWorker[];

  const byGroup = new Map<string, GroupWorker[]>();
  for (const w of workers) {
    if (!w.group_id) continue;
    const list = byGroup.get(w.group_id) ?? [];
    list.push(w);
    byGroup.set(w.group_id, list);
  }
  const ungrouped = workers.filter((w) => !w.group_id).length;

  return (
    <div>
      <PageHeader
        title="Employee groups"
        subtitle={`${groups.length} group(s) · ${ungrouped} ungrouped employee(s)`}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <Section title="New group">
            <Card className="p-5">
              <CreateGroupForm />
              <p className="text-muted text-xs mt-3">
                Assign employees to a group from each employee&apos;s edit form.
              </p>
            </Card>
          </Section>
        </div>

        <div className="lg:col-span-2">
          <Section title="Groups">
            {groups.length === 0 ? (
              <Empty>No groups yet. Create the first one.</Empty>
            ) : (
              <div className="space-y-5">
                {groups.map((g) => {
                  const members = byGroup.get(g.id) ?? [];
                  return (
                    <Card key={g.id} className="p-5">
                      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-ink">{g.name}</span>
                          <Badge tone={members.length ? "info" : "neutral"}>
                            {members.length} employee(s)
                          </Badge>
                        </div>
                        {members.length === 0 ? (
                          <DeleteGroupButton id={g.id} />
                        ) : (
                          <span className="text-muted text-xs">
                            Remove all employees to delete this group.
                          </span>
                        )}
                      </div>

                      {members.length === 0 ? (
                        <p className="text-muted text-sm">No employees in this group.</p>
                      ) : (
                        <Table
                          head={
                            <tr>
                              <Th>Employee</Th>
                              <Th>Code</Th>
                              <Th></Th>
                            </tr>
                          }
                        >
                          {members.map((w) => (
                            <tr key={w.id}>
                              <Td>{w.full_name}</Td>
                              <Td className="tabular">{w.employee_code}</Td>
                              <Td className="text-right">
                                <RemoveWorkerButton workerId={w.id} />
                              </Td>
                            </tr>
                          ))}
                        </Table>
                      )}
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

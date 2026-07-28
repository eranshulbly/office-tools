import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageHeader, LinkButton, Button, Table, Th, Td, Badge, Empty, FormError } from "@/components/ui";

type AuditRow = {
  id: number;
  created_at: string;
  action: string;
  entity_table: string;
  entity_id: string;
  reason: string | null;
  before_value: unknown;
  after_value: unknown;
  actor_id: string | null;
  actor: { full_name: string } | { full_name: string }[] | null;
};

const inputClass = "mt-1 w-full rounded border border-line px-3 py-2 text-sm";

function actorName(actor: AuditRow["actor"]): string {
  const a = Array.isArray(actor) ? actor[0] : actor;
  return a?.full_name ?? "—";
}

function JsonCell({ label, value }: { label: string; value: unknown }) {
  if (value == null) return <span className="text-muted">—</span>;
  const text = JSON.stringify(value, null, 2);
  return (
    <details>
      <summary className="cursor-pointer text-brand text-xs">{label}</summary>
      <pre className="mt-1 max-w-md overflow-x-auto whitespace-pre-wrap break-words rounded bg-gray-50 p-2 text-xs">
        {text}
      </pre>
    </details>
  );
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ actor?: string; entity_table?: string; from?: string; to?: string }>;
}) {
  await requireRole("admin");
  const sp = await searchParams;

  const supabase = await createSupabaseServerClient();

  // Filter options.
  const { data: profileRows } = await supabase
    .from("profiles")
    .select("id, full_name")
    .order("full_name");
  const profiles = (profileRows ?? []) as { id: string; full_name: string }[];

  const { data: tableRows } = await supabase
    .from("audit_log")
    .select("entity_table")
    .order("entity_table")
    .limit(2000);
  const entityTables = Array.from(
    new Set(((tableRows ?? []) as { entity_table: string }[]).map((r) => r.entity_table))
  );

  // Main query — most recent first, latest 200, with filters.
  let query = supabase
    .from("audit_log")
    .select(
      "id, created_at, action, entity_table, entity_id, reason, before_value, after_value, actor_id, actor:profiles(full_name)"
    )
    .order("created_at", { ascending: false })
    .limit(200);

  if (sp.actor) query = query.eq("actor_id", sp.actor);
  if (sp.entity_table) query = query.eq("entity_table", sp.entity_table);
  if (sp.from) query = query.gte("created_at", `${sp.from}T00:00:00`);
  if (sp.to) query = query.lte("created_at", `${sp.to}T23:59:59.999`);

  const { data, error } = await query;
  const rows = (data ?? []) as unknown as AuditRow[];

  const hasFilter = Boolean(sp.actor || sp.entity_table || sp.from || sp.to);

  return (
    <div>
      <PageHeader title="Audit log" subtitle="Every recorded decision, most recent first (latest 200)." />

      <form method="get" className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-5 items-end">
        <label className="block text-sm">
          <span className="text-muted">Actor</span>
          <select name="actor" defaultValue={sp.actor ?? ""} className={inputClass}>
            <option value="">All</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="text-muted">Entity</span>
          <select name="entity_table" defaultValue={sp.entity_table ?? ""} className={inputClass}>
            <option value="">All</option>
            {entityTables.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="text-muted">From</span>
          <input type="date" name="from" defaultValue={sp.from ?? ""} className={inputClass} />
        </label>

        <label className="block text-sm">
          <span className="text-muted">To</span>
          <input type="date" name="to" defaultValue={sp.to ?? ""} className={inputClass} />
        </label>

        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary">
            Filter
          </Button>
          {hasFilter && (
            <LinkButton href="/audit" variant="ghost">
              Clear
            </LinkButton>
          )}
        </div>
      </form>

      {error && <FormError message={error.message} />}

      {rows.length === 0 ? (
        <Empty>No audit entries{hasFilter ? " match these filters" : " yet"}.</Empty>
      ) : (
        <Table
          head={
            <tr>
              <Th className="whitespace-nowrap">When</Th>
              <Th>Actor</Th>
              <Th>Action</Th>
              <Th>Entity</Th>
              <Th>Entity ID</Th>
              <Th>Reason</Th>
              <Th>Change</Th>
            </tr>
          }
        >
          {rows.map((r) => (
            <tr key={r.id}>
              <Td className="tabular whitespace-nowrap align-top">
                {new Date(r.created_at).toLocaleString("en-IN")}
              </Td>
              <Td className="align-top">{actorName(r.actor)}</Td>
              <Td className="align-top">
                <Badge tone="info">{r.action}</Badge>
              </Td>
              <Td className="align-top whitespace-nowrap">{r.entity_table}</Td>
              <Td className="align-top tabular text-xs">{r.entity_id}</Td>
              <Td className="align-top">{r.reason ?? <span className="text-muted">—</span>}</Td>
              <Td className="align-top">
                <div className="space-y-1">
                  <JsonCell label="before" value={r.before_value} />
                  <JsonCell label="after" value={r.after_value} />
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

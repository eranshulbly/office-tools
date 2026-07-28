import type { ReactNode } from "react";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types";
import { PageHeader, Card, Section, LinkButton, Table, Th, Td, Badge, Empty } from "@/components/ui";
import { WorkerAvatar } from "@/components/WorkerAvatar";
import { signedPhotoUrlMap } from "@/lib/storage";

type SupabaseServer = Awaited<ReturnType<typeof createSupabaseServerClient>>;

// ---- helpers ---------------------------------------------------------------

function fmtDate(y: number, monthIndex: number, day: number): string {
  const d = new Date(y, monthIndex, day);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Current payroll period = the current calendar month (1st → last day). */
function currentPeriod(): { start: string; end: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const last = new Date(y, m + 1, 0).getDate();
  return { start: fmtDate(y, m, 1), end: fmtDate(y, m, last) };
}

function startOfTodayIso(): string {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return t.toISOString();
}

function num(map: Record<string, unknown>, key: string, fallback: number): number {
  const v = map[key];
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---- shared stat tile ------------------------------------------------------

function Stat({
  label,
  value,
  tone,
  href,
  linkLabel,
}: {
  label: string;
  value: ReactNode;
  tone?: "danger" | "warn" | "ok";
  href?: string;
  linkLabel?: string;
}) {
  const valueColor =
    tone === "danger"
      ? "text-[var(--color-danger)]"
      : tone === "warn"
        ? "text-[var(--color-warn)]"
        : tone === "ok"
          ? "text-[var(--color-ok)]"
          : "text-ink";
  return (
    <Card className="p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular ${valueColor}`}>{value}</div>
      {href && (
        <div className="mt-2">
          <LinkButton href={href} variant="ghost">
            {linkLabel ?? "View"}
          </LinkButton>
        </div>
      )}
    </Card>
  );
}

// ---- admin dashboard -------------------------------------------------------

async function AdminDashboard(supabase: SupabaseServer): Promise<ReactNode> {
  const { data: settingsRows } = await supabase.from("settings").select("key, value");
  const settings = Object.fromEntries(
    ((settingsRows ?? []) as { key: string; value: unknown }[]).map((s) => [s.key, s.value])
  ) as Record<string, unknown>;

  const offlineHours = num(settings, "device_offline_alert_hours", 2);
  const driftMinutes = num(settings, "clock_drift_alert_minutes", 5);
  const manualThreshold = num(settings, "manual_entry_alert_threshold", 3);
  const period = currentPeriod();

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [
    punchRes,
    devicesRes,
    pendingAdjRes,
    lateRes,
    newWorkerRes,
    editReqRes,
    unresolvedRes,
    approvedAdjRes,
  ] = await Promise.all([
    supabase.from("raw_punches").select("*", { count: "exact", head: true }).gte("device_ts", dayAgo),
    supabase.from("devices").select("*").order("label"),
    supabase.from("adjustments").select("*", { count: "exact", head: true }).eq("status", "pending"),
    // Other HR approval flows that live on /approvals:
    supabase.from("attendance_days").select("*", { count: "exact", head: true }).eq("status", "late_review"),
    supabase.from("workers").select("*", { count: "exact", head: true }).eq("approval_status", "pending"),
    supabase.from("worker_edit_requests").select("*", { count: "exact", head: true }).eq("status", "pending"),
    supabase
      .from("attendance_days")
      .select("worker_id, day, worker:workers(full_name, employee_code, photo_path)", { count: "exact" })
      .eq("status", "unresolved")
      .order("day", { ascending: false })
      .limit(25),
    supabase
      .from("adjustments")
      .select("worker_id, worker:workers(full_name, employee_code, photo_path)")
      .eq("status", "approved")
      .gte("day", period.start)
      .lte("day", period.end),
  ]);

  const punchCount = punchRes.count ?? 0;
  const pendingAdj = pendingAdjRes.count ?? 0;
  const lateCount = lateRes.count ?? 0;
  const newWorkerCount = newWorkerRes.count ?? 0;
  const editReqCount = editReqRes.count ?? 0;
  const unresolvedCount = unresolvedRes.count ?? 0;

  type Device = {
    serial_number: string;
    label: string;
    last_seen_at: string | null;
    last_device_time: string | null;
    is_active: boolean | null;
  };
  const devices = (devicesRes.data ?? []) as Device[];

  type WorkerRefShape = { full_name: string; employee_code: string; photo_path: string | null };
  type WorkerRef = WorkerRefShape | WorkerRefShape[] | null;
  const one = (w: WorkerRef) => (Array.isArray(w) ? w[0] : w);

  const unresolved = (unresolvedRes.data ?? []) as unknown as {
    worker_id: string;
    day: string;
    worker: WorkerRef;
  }[];

  // High-manual-entry: approved adjustments in period, grouped by worker.
  const approvedAdj = (approvedAdjRes.data ?? []) as unknown as {
    worker_id: string;
    worker: WorkerRef;
  }[];
  const manualCounts = new Map<
    string,
    { name: string; code: string; count: number; photo_path: string | null }
  >();
  for (const a of approvedAdj) {
    const w = one(a.worker);
    const cur = manualCounts.get(a.worker_id) ?? {
      name: w?.full_name ?? a.worker_id,
      code: w?.employee_code ?? "",
      count: 0,
      photo_path: w?.photo_path ?? null,
    };
    cur.count += 1;
    manualCounts.set(a.worker_id, cur);
  }
  const highManual = Array.from(manualCounts.values())
    .filter((w) => w.count > manualThreshold)
    .sort((a, b) => b.count - a.count);

  // Batch-sign every photo path we might render (one round-trip).
  const photoMap = await signedPhotoUrlMap([
    ...unresolved.map((u) => one(u.worker)?.photo_path),
    ...highManual.map((w) => w.photo_path),
  ]);

  const now = Date.now();
  const offlineMs = offlineHours * 60 * 60 * 1000;
  const driftMs = driftMinutes * 60 * 1000;

  return (
    <div>
      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Stat label="Punches (last 24h)" value={punchCount} />
          <Stat
            label="Pending adjustments"
            value={pendingAdj}
            tone={pendingAdj > 0 ? "warn" : undefined}
            href="/approvals"
            linkLabel="Go to approvals"
          />
          <Stat
            label="Late arrivals (after 10 PM)"
            value={lateCount}
            tone={lateCount > 0 ? "warn" : undefined}
            href="/approvals"
            linkLabel="Review in approvals"
          />
          <Stat
            label="New employee requests"
            value={newWorkerCount}
            tone={newWorkerCount > 0 ? "warn" : undefined}
            href="/approvals"
            linkLabel="Review in approvals"
          />
          <Stat
            label="Employee changes"
            value={editReqCount}
            tone={editReqCount > 0 ? "warn" : undefined}
            href="/approvals"
            linkLabel="Review in approvals"
          />
          <Stat
            label="Unresolved days"
            value={unresolvedCount}
            tone={unresolvedCount > 0 ? "danger" : "ok"}
            href="/attendance"
            linkLabel="Resolve in attendance"
          />
        </div>
        {unresolvedCount > 0 && (
          <p className="mt-2 text-sm text-[var(--color-danger)]">
            Unresolved days block payroll for the period. Clear every one before a run can compute.
          </p>
        )}
      </Section>

      <Section title="Device health">
        {devices.length === 0 ? (
          <Empty>No devices registered.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <Th>Label</Th>
                <Th>Serial</Th>
                <Th>Last seen</Th>
                <Th>Last device time</Th>
                <Th>Status</Th>
              </tr>
            }
          >
            {devices.map((d) => {
              const lastSeen = d.last_seen_at ? new Date(d.last_seen_at).getTime() : null;
              const offline = lastSeen == null || now - lastSeen > offlineMs;
              const drift =
                d.last_device_time != null && d.last_seen_at != null
                  ? Math.abs(new Date(d.last_device_time).getTime() - new Date(d.last_seen_at).getTime()) >
                    driftMs
                  : false;
              return (
                <tr key={d.serial_number}>
                  <Td className="font-medium">{d.label}</Td>
                  <Td className="tabular text-xs">{d.serial_number}</Td>
                  <Td className="tabular whitespace-nowrap">
                    {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString("en-IN") : "—"}
                  </Td>
                  <Td className="tabular whitespace-nowrap">
                    {d.last_device_time ? new Date(d.last_device_time).toLocaleString("en-IN") : "—"}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {offline ? <Badge tone="danger">Offline</Badge> : <Badge tone="ok">Online</Badge>}
                      {drift && <Badge tone="warn">Clock drift</Badge>}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
        <p className="mt-2 text-xs text-muted">
          Offline if last check-in is older than {offlineHours}h. Clock drift if device time and server
          time diverge beyond {driftMinutes} min (§9 canary).
        </p>
      </Section>

      <Section title={`Exceptions — unresolved days (${period.start} to ${period.end} period and older)`}>
        {unresolved.length === 0 ? (
          <Empty>No unresolved days. Payroll is not blocked.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <Th>Day</Th>
                <Th>Code</Th>
                <Th>Employee</Th>
              </tr>
            }
          >
            {unresolved.map((u) => {
              const w = one(u.worker);
              return (
                <tr key={`${u.worker_id}-${u.day}`}>
                  <Td className="tabular">{u.day}</Td>
                  <Td className="font-medium">{w?.employee_code ?? ""}</Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <WorkerAvatar
                        name={w?.full_name ?? u.worker_id}
                        url={w?.photo_path ? photoMap[w.photo_path] : null}
                        size="sm"
                      />
                      <span>{w?.full_name ?? u.worker_id}</span>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Section>

      <Section
        title={`High manual-entry employees — approved adjustments this period (> ${manualThreshold})`}
      >
        {highManual.length === 0 ? (
          <Empty>No employee exceeds the manual-entry threshold this period.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <Th>Code</Th>
                <Th>Employee</Th>
                <Th className="text-right">Approved adjustments</Th>
              </tr>
            }
          >
            {highManual.map((w) => (
              <tr key={w.code || w.name}>
                <Td className="font-medium">{w.code}</Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <WorkerAvatar
                      name={w.name}
                      url={w.photo_path ? photoMap[w.photo_path] : null}
                      size="sm"
                    />
                    <span>{w.name}</span>
                  </div>
                </Td>
                <Td className="tabular text-right">
                  <Badge tone="danger">{w.count}</Badge>
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-2 text-xs text-muted">
          Manual entry is the primary fraud control (§3.5). Investigate employees well above the norm.
        </p>
      </Section>
    </div>
  );
}

// ---- manager dashboard -----------------------------------------------------

async function ManagerDashboard(supabase: SupabaseServer): Promise<ReactNode> {
  const startToday = startOfTodayIso();

  const [workersRes, punchesRes] = await Promise.all([
    supabase
      .from("workers")
      .select("id, full_name, employee_code, photo_path")
      .eq("is_active", true)
      .order("full_name"),
    supabase.from("raw_punches").select("worker_id").gte("device_ts", startToday),
  ]);

  const workers = (workersRes.data ?? []) as {
    id: string;
    full_name: string;
    employee_code: string;
    photo_path: string | null;
  }[];
  const punches = (punchesRes.data ?? []) as { worker_id: string | null }[];

  const punchedIds = new Set(punches.map((p) => p.worker_id).filter((x): x is string => Boolean(x)));

  const inToday = workers.filter((w) => punchedIds.has(w.id));
  const notPunched = workers.filter((w) => !punchedIds.has(w.id));

  const photoMap = await signedPhotoUrlMap(workers.map((w) => w.photo_path));

  const list = (rows: typeof workers, emptyText: string) =>
    rows.length === 0 ? (
      <Empty>{emptyText}</Empty>
    ) : (
      <Table
        head={
          <tr>
            <Th>Code</Th>
            <Th>Employee</Th>
          </tr>
        }
      >
        {rows.map((w) => (
          <tr key={w.id}>
            <Td className="font-medium">{w.employee_code}</Td>
            <Td>
              <div className="flex items-center gap-2">
                <WorkerAvatar
                  name={w.full_name}
                  url={w.photo_path ? photoMap[w.photo_path] : null}
                  size="sm"
                />
                <span>{w.full_name}</span>
              </div>
            </Td>
          </tr>
        ))}
      </Table>
    );

  return (
    <div>
      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Stat label="In today" value={inToday.length} tone={inToday.length > 0 ? "ok" : undefined} />
          <Stat
            label="Not punched"
            value={notPunched.length}
            tone={notPunched.length > 0 ? "warn" : "ok"}
          />
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section title={`In today (${inToday.length})`}>
          {list(inToday, "No punches recorded yet today.")}
        </Section>
        <Section title={`Not punched (${notPunched.length})`}>
          {list(notPunched, "Everyone active has punched today.")}
        </Section>
      </div>
    </div>
  );
}

// ---- page ------------------------------------------------------------------

export default async function DashboardPage() {
  const profile: Profile = await requireRole("admin", "manager");
  const supabase = await createSupabaseServerClient();

  const isAdmin = profile.role === "admin";

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={
          isAdmin
            ? "Today's activity, device health, and open items that need attention."
            : `Who's in and who hasn't punched today, ${profile.full_name.split(" ")[0]}.`
        }
      />
      {isAdmin ? await AdminDashboard(supabase) : await ManagerDashboard(supabase)}
    </div>
  );
}

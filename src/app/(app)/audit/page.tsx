import Link from "next/link";
import { requireFeature } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageHeader, LinkButton, Button, Table, Th, Td, Badge, Empty, FormError } from "@/components/ui";

/**
 * The punch log: every fingerprint read the terminals have pushed, newest first.
 *
 * This page used to render audit_log, which in practice holds nothing but
 * cheque lifecycle rows — the wrong content for an HR-suite tile, and noise
 * when the question is "did the device record this person today?". Cheque
 * history still accumulates in audit_log and is unaffected; it is simply not
 * shown here.
 *
 * raw_punches is append-only and is the device's own record, so this is the
 * ground truth behind the attendance grid: when a day looks wrong, the reason
 * is visible here.
 */

const LIMIT = 200;
const IST_OFFSET_MINUTES = 330; // +05:30, no DST — the warehouse timezone.
const DRIFT_ALERT_MINUTES = 5;

type Emp = { full_name: string; employee_code: string };

type PunchRow = {
  id: number;
  device_serial: string;
  device_user_id: number;
  device_ts: string;
  server_ts: string;
  verify_mode: number | null;
  raw_line: string;
  worker_id: string | null;
  worker: Emp | Emp[] | null;
};

const inputClass = "mt-1 w-full rounded border border-line px-3 py-2 text-sm";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(s: string | undefined): s is string {
  return !!s && DATE_RE.test(s);
}

/**
 * Start of an IST calendar day, as the UTC "YYYY-MM-DD HH:MM:SS" MySQL wants.
 *
 * device_ts is stored in UTC, but the user picks a date in warehouse-local
 * terms. Filtering on the bare date would shift the window by 5h30m and drop
 * the early-morning punches — the shift-start ones — off the front of the day.
 */
function istDayStartUtc(day: string, addDays = 0): string {
  const t =
    Date.parse(day + "T00:00:00Z") - IST_OFFSET_MINUTES * 60_000 + addDays * 86_400_000;
  return new Date(t).toISOString().slice(0, 19).replace("T", " ");
}

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString("en-IN") : "—";
}

function driftMinutes(deviceTs: string, serverTs: string): number {
  return Math.abs(new Date(deviceTs).getTime() - new Date(serverTs).getTime()) / 60_000;
}

function one(v: Emp | Emp[] | null): Emp | null {
  return Array.isArray(v) ? v[0] ?? null : v;
}

export default async function PunchLogPage({
  searchParams,
}: {
  searchParams: Promise<{ worker?: string; from?: string; to?: string; device?: string }>;
}) {
  await requireFeature("audit");
  const sp = await searchParams;

  const supabase = await createSupabaseServerClient();

  const [{ data: workerRows }, { data: deviceRows }] = await Promise.all([
    supabase.from("workers").select("id, full_name").eq("is_active", true).order("full_name"),
    supabase.from("devices").select("serial_number, label").order("serial_number"),
  ]);
  const workers = (workerRows ?? []) as { id: string; full_name: string }[];
  const devices = (deviceRows ?? []) as { serial_number: string; label: string | null }[];

  let query = supabase
    .from("raw_punches")
    .select(
      "id, device_serial, device_user_id, device_ts, server_ts, verify_mode, raw_line, worker_id, worker:workers(full_name, employee_code)"
    )
    .order("device_ts", { ascending: false })
    .limit(LIMIT);

  if (sp.worker) query = query.eq("worker_id", sp.worker);
  if (sp.device) query = query.eq("device_serial", sp.device);
  if (isDate(sp.from)) query = query.gte("device_ts", istDayStartUtc(sp.from));
  if (isDate(sp.to)) query = query.lt("device_ts", istDayStartUtc(sp.to, 1));

  const { data, error } = await query;
  const rows = (data ?? []) as unknown as PunchRow[];

  const hasFilter = Boolean(sp.worker || sp.device || sp.from || sp.to);

  return (
    <div>
      <PageHeader
        title="Punch log"
        subtitle={`Every fingerprint read pushed by the terminals, most recent first (latest ${LIMIT}).`}
      />

      <form method="get" className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-5 items-end">
        <label className="block text-sm">
          <span className="text-muted">Employee</span>
          <select name="worker" defaultValue={sp.worker ?? ""} className={inputClass}>
            <option value="">All</option>
            {workers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.full_name}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="text-muted">Device</span>
          <select name="device" defaultValue={sp.device ?? ""} className={inputClass}>
            <option value="">All</option>
            {devices.map((d) => (
              <option key={d.serial_number} value={d.serial_number}>
                {d.label ?? d.serial_number}
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
        <Empty>No punches{hasFilter ? " match these filters" : " recorded yet"}.</Empty>
      ) : (
        <Table
          head={
            <tr>
              <Th className="whitespace-nowrap">Device time</Th>
              <Th className="whitespace-nowrap">Server time</Th>
              <Th>Drift</Th>
              <Th>Employee</Th>
              <Th>PIN</Th>
              <Th>Device</Th>
              <Th>Verify</Th>
              <Th>Raw line</Th>
            </tr>
          }
        >
          {rows.map((p) => {
            const w = one(p.worker);
            const drift = driftMinutes(p.device_ts, p.server_ts);
            return (
              <tr key={p.id}>
                <Td className="tabular whitespace-nowrap">{fmt(p.device_ts)}</Td>
                <Td className="tabular whitespace-nowrap text-muted">{fmt(p.server_ts)}</Td>
                <Td>
                  {drift > DRIFT_ALERT_MINUTES ? (
                    <Badge tone="danger">{drift.toFixed(1)}m</Badge>
                  ) : (
                    <span className="text-muted tabular">{drift.toFixed(1)}m</span>
                  )}
                </Td>
                <Td>
                  {p.worker_id && w ? (
                    <Link
                      href={`/attendance/${p.worker_id}`}
                      className="text-brand hover:underline"
                    >
                      {w.full_name}
                    </Link>
                  ) : (
                    // A punch the gateway could not attribute: the terminal PIN
                    // maps to no employee. Shown rather than hidden — it means
                    // somebody's attendance is going nowhere.
                    <Badge tone="danger">Unmapped PIN</Badge>
                  )}
                </Td>
                <Td className="tabular">{p.device_user_id}</Td>
                <Td className="tabular text-xs text-muted">{p.device_serial}</Td>
                <Td className="tabular">{p.verify_mode ?? "—"}</Td>
                <Td className="font-mono text-xs text-muted whitespace-pre">{p.raw_line}</Td>
              </tr>
            );
          })}
        </Table>
      )}
    </div>
  );
}

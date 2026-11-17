import Link from "next/link";
import { requireFeature } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageHeader, Section, Table, Th, Td, Badge, Empty } from "@/components/ui";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function nextDay(day: string): string {
  const dt = new Date(day + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

function fmt(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-IN");
}

// Absolute minutes between device_ts and server_ts — the clock-drift canary (§9).
function driftMinutes(deviceTs: string, serverTs: string): number {
  return Math.abs(new Date(deviceTs).getTime() - new Date(serverTs).getTime()) / 60000;
}

const DRIFT_ALERT_MINUTES = 5; // settings.clock_drift_alert_minutes default (§4.1)

type Punch = {
  id: number;
  device_serial: string;
  device_user_id: number;
  device_ts: string;
  server_ts: string;
  verify_mode: number | null;
  raw_line: string;
};

export default async function WorkerPunchesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workerId: string }>;
  searchParams: Promise<{ day?: string }>;
}) {
  await requireFeature("attendance");
  const { workerId } = await params;
  const sp = await searchParams;
  const day = sp.day && DATE_RE.test(sp.day) ? sp.day : todayStr();

  const supabase = await createSupabaseServerClient();

  const [{ data: worker }, { data: punches }] = await Promise.all([
    supabase
      .from("workers")
      .select("employee_code, full_name, designation")
      .eq("id", workerId)
      .maybeSingle(),
    supabase
      .from("raw_punches")
      .select("id, device_serial, device_user_id, device_ts, server_ts, verify_mode, raw_line")
      .eq("worker_id", workerId)
      .gte("device_ts", `${day}T00:00:00+00:00`)
      .lt("device_ts", `${nextDay(day)}T00:00:00+00:00`)
      .order("device_ts", { ascending: true }),
  ]);

  const list = (punches ?? []) as Punch[];
  const title = worker
    ? `${(worker as { full_name: string }).full_name}`
    : "Employee";
  const code = worker ? (worker as { employee_code: string }).employee_code : "";

  return (
    <div>
      <PageHeader
        title={`Raw punches — ${title}`}
        subtitle={`${code ? code + " · " : ""}${day} · append-only device record (read-only)`}
        actions={
          <Link href={`/attendance?day=${day}`} className="text-brand text-sm hover:underline">
            ← Back to day grid
          </Link>
        }
      />

      <Section>
        <p className="text-sm text-muted mb-3">
          Both <span className="font-medium">device time</span> and{" "}
          <span className="font-medium">server time</span> are shown. A divergence beyond{" "}
          {DRIFT_ALERT_MINUTES} minutes is the clock-drift canary (§9) and is flagged below.
        </p>
        {list.length === 0 ? (
          <Empty>No punches recorded for this employee on {day}.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <Th>Device</Th>
                <Th>PIN</Th>
                <Th>Device time</Th>
                <Th>Server time</Th>
                <Th>Drift</Th>
                <Th>Verify</Th>
                <Th>Raw line</Th>
              </tr>
            }
          >
            {list.map((p) => {
              const drift = driftMinutes(p.device_ts, p.server_ts);
              const over = drift > DRIFT_ALERT_MINUTES;
              return (
                <tr key={p.id}>
                  <Td className="tabular">{p.device_serial}</Td>
                  <Td className="tabular">{p.device_user_id}</Td>
                  <Td className="tabular">{fmt(p.device_ts)}</Td>
                  <Td className="tabular">{fmt(p.server_ts)}</Td>
                  <Td>
                    {over ? (
                      <Badge tone="danger">{drift.toFixed(1)}m</Badge>
                    ) : (
                      <span className="text-muted tabular">{drift.toFixed(1)}m</span>
                    )}
                  </Td>
                  <Td className="tabular">{p.verify_mode ?? "—"}</Td>
                  <Td className="font-mono text-xs text-muted whitespace-pre">{p.raw_line}</Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Section>
    </div>
  );
}

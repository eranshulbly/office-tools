import Link from "next/link";
import { requireFeature } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { DayStatus } from "@/lib/types";
import {
  PageHeader,
  Section,
  Card,
  Table,
  Th,
  Td,
  Badge,
  Empty,
  LinkButton,
} from "@/components/ui";
import { statusView, warehouseToday } from "@/lib/attendance-status";
import { Recompute } from "./Recompute";
import { WorkerSummaryButton } from "./WorkerSummaryButton";
import { EditTimingButton } from "./EditTimingButton";

// Labels and tones live in @/lib/attendance-status so the day grid, the
// per-worker summary and the payroll exception lists cannot drift apart.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The warehouse's today, not UTC's: between midnight and 05:30 IST those are
// different dates, and the grid would open on yesterday.
const todayStr = warehouseToday;

function shiftDay(day: string, delta: number): string {
  const dt = new Date(day + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function fmtTime(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

type WorkerRow = { id: string; employee_code: string; full_name: string; designation: string | null };
type AttRow = {
  worker_id: string;
  first_in: string | null;
  last_out: string | null;
  worked_hours: number | string | null;
  status: DayStatus;
  is_from_adjustment: boolean;
};

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string }>;
}) {
  await requireFeature("attendance");
  const sp = await searchParams;
  const day = sp.day && DATE_RE.test(sp.day) ? sp.day : todayStr();

  const supabase = await createSupabaseServerClient();

  const [{ data: workers }, { data: att }] = await Promise.all([
    supabase
      .from("workers")
      .select("id, employee_code, full_name, designation")
      .eq("is_active", true)
      .order("employee_code"),
    supabase
      .from("attendance_days")
      .select("worker_id, first_in, last_out, worked_hours, status, is_from_adjustment")
      .eq("day", day),
  ]);

  // Shown in the edit dialog so an admin can see which side of the line a span
  // falls on before saving, rather than saving and then reading the badge.
  const { data: fullDayRow } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "full_day_hours")
    .maybeSingle();
  const fullDayHours = Number((fullDayRow as { value: unknown } | null)?.value ?? 8) || 8;

  const byWorker = new Map<string, AttRow>();
  for (const r of (att ?? []) as AttRow[]) byWorker.set(r.worker_id, r);

  const rows = (workers ?? []) as WorkerRow[];

  return (
    <div>
      <PageHeader
        title="Attendance"
        subtitle="Per-employee day grid. Click a name for their monthly summary; edit a timing to correct a day."
      />

      <Section>
        <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
          <form className="flex items-end gap-2">
            <label className="block">
              <span className="text-sm text-muted">Day</span>
              <input
                type="date"
                name="day"
                defaultValue={day}
                className="mt-1 w-full rounded border border-line px-3 py-2 text-sm"
              />
            </label>
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded border border-line bg-white px-3 py-1.5 text-sm font-medium text-ink hover:bg-gray-50"
            >
              Go
            </button>
          </form>
          <div className="flex items-center gap-2">
            <LinkButton href={`/attendance?day=${shiftDay(day, -1)}`}>← Prev day</LinkButton>
            <LinkButton href={`/attendance?day=${todayStr()}`}>Today</LinkButton>
            <LinkButton href={`/attendance?day=${shiftDay(day, 1)}`}>Next day →</LinkButton>
          </div>
        </div>

        {rows.length === 0 ? (
          <Empty>No active employees.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <Th>Code</Th>
                <Th>Employee</Th>
                <Th>Status</Th>
                <Th>First in</Th>
                <Th>Last out</Th>
                <Th className="text-right">Hours</Th>
                <Th>Source</Th>
                <Th />
              </tr>
            }
          >
            {rows.map((w) => {
              const a = byWorker.get(w.id);
              return (
                <tr key={w.id}>
                  <Td className="tabular text-muted">{w.employee_code}</Td>
                  <Td>
                    <WorkerSummaryButton
                      workerId={w.id}
                      name={w.full_name}
                      code={w.employee_code}
                      designation={w.designation}
                    />
                  </Td>
                  <Td>
                    {a ? (
                      (() => {
                        const v = statusView(a.status, day);
                        return <Badge tone={v.tone}>{v.label}</Badge>;
                      })()
                    ) : (
                      <Badge tone="neutral">No data</Badge>
                    )}
                  </Td>
                  <Td className="tabular">{fmtTime(a?.first_in ?? null)}</Td>
                  <Td className="tabular">{fmtTime(a?.last_out ?? null)}</Td>
                  <Td className="tabular text-right">
                    {a?.worked_hours != null ? Number(a.worked_hours).toFixed(2) : "—"}
                  </Td>
                  <Td>
                    {a?.is_from_adjustment ? (
                      <Badge tone="info">Adjustment</Badge>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  <Td>
                    <div className="flex items-center gap-3 whitespace-nowrap">
                      <EditTimingButton
                        workerId={w.id}
                        name={w.full_name}
                        code={w.employee_code}
                        day={day}
                        firstIn={a?.first_in ?? null}
                        lastOut={a?.last_out ?? null}
                        fullDayHours={fullDayHours}
                      />
                      <Link
                        href={`/attendance/${w.id}?day=${day}`}
                        className="text-brand text-sm hover:underline"
                      >
                        Punches →
                      </Link>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Section>

      <Section title="Recompute">
        <Card className="p-4">
          <Recompute defaultDay={day} />
        </Card>
      </Section>
    </div>
  );
}

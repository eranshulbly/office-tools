import Link from "next/link";
import { requireRole } from "@/lib/auth";
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
import { Recompute } from "./Recompute";
import { WorkerSummaryButton } from "./WorkerSummaryButton";

type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "info";

const STATUS_TONE: Record<DayStatus, BadgeTone> = {
  full_day: "ok",
  absent: "warn",
  unresolved: "danger",
  not_working_day: "neutral",
  late_review: "danger",
  half_day: "neutral", // legacy only — kept to satisfy the exhaustive Record over DayStatus
};

const STATUS_LABEL: Record<DayStatus, string> = {
  full_day: "Full day",
  absent: "Absent",
  unresolved: "Unresolved",
  not_working_day: "Not working",
  late_review: "Late — review",
  half_day: "Half day (legacy)", // legacy only — never produced now
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDay(day: string, delta: number): string {
  const dt = new Date(day + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function fmtTime(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

type WorkerRow = { id: string; employee_code: string; full_name: string };
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
  await requireRole("admin");
  const sp = await searchParams;
  const day = sp.day && DATE_RE.test(sp.day) ? sp.day : todayStr();

  const supabase = await createSupabaseServerClient();

  const [{ data: workers }, { data: att }] = await Promise.all([
    supabase
      .from("workers")
      .select("id, employee_code, full_name")
      .eq("is_active", true)
      .order("employee_code"),
    supabase
      .from("attendance_days")
      .select("worker_id, first_in, last_out, worked_hours, status, is_from_adjustment")
      .eq("day", day),
  ]);

  const byWorker = new Map<string, AttRow>();
  for (const r of (att ?? []) as AttRow[]) byWorker.set(r.worker_id, r);

  const rows = (workers ?? []) as WorkerRow[];

  return (
    <div>
      <PageHeader
        title="Attendance"
        subtitle="Per-employee day grid. Click a name for their monthly summary. Read-only."
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
                    />
                  </Td>
                  <Td>
                    {a ? (
                      <Badge tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Badge>
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
                    <Link
                      href={`/attendance/${w.id}?day=${day}`}
                      className="text-brand text-sm hover:underline"
                    >
                      Punches →
                    </Link>
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

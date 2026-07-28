import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { CalendarDayType } from "@/lib/types";
import { PageHeader, Section, LinkButton } from "@/components/ui";
import { DayCell } from "./DayCell";
import { DAY_TYPE_META } from "./meta";

const MONTH_RE = /^\d{4}-\d{2}$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

type CalRow = { day: string; day_type: CalendarDayType; note: string | null };

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  await requireRole("admin");
  const sp = await searchParams;
  const month = sp.month && MONTH_RE.test(sp.month) ? sp.month : currentMonth();

  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const startWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0 = Sunday
  const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("work_calendar")
    .select("day, day_type, note")
    .gte("day", `${month}-01`)
    .lte("day", `${month}-${String(daysInMonth).padStart(2, "0")}`);

  const byDay = new Map<string, CalRow>();
  for (const r of (data ?? []) as CalRow[]) byDay.set(r.day, r);

  const today = todayStr();

  // Cells: leading blanks to align the 1st under its weekday, then the days.
  const cells: Array<{ dayNum: number; day: string; type: CalendarDayType; note: string | null } | null> =
    [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const day = `${month}-${String(d).padStart(2, "0")}`;
    const isSunday = new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
    const row = byDay.get(day);
    const type: CalendarDayType = row ? row.day_type : isSunday ? "closed" : "working";
    cells.push({ dayNum: d, day, type, note: row?.note ?? null });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div>
      <PageHeader
        title="Work calendar"
        subtitle="Mark each day working / closed / extra / swapped. Payroll depends on this."
        actions={
          <div className="flex items-center gap-2">
            <LinkButton href={`/calendar?month=${shiftMonth(month, -1)}`}>← Prev</LinkButton>
            <LinkButton href={`/calendar?month=${currentMonth()}`}>This month</LinkButton>
            <LinkButton href={`/calendar?month=${shiftMonth(month, 1)}`}>Next →</LinkButton>
          </div>
        }
      />

      <Section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-ink">{monthLabel}</h2>
          <div className="flex flex-wrap items-center gap-3">
            {(Object.keys(DAY_TYPE_META) as CalendarDayType[]).map((t) => (
              <span key={t} className="flex items-center gap-1.5 text-xs text-muted">
                <span className={`inline-block h-3 w-3 rounded-sm ${DAY_TYPE_META[t].swatch}`} />
                {DAY_TYPE_META[t].label}
              </span>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-line bg-surface p-2">
          <div className="grid grid-cols-7 gap-1">
            {WEEKDAYS.map((w) => (
              <div key={w} className="px-2 py-1 text-center text-xs font-medium text-muted">
                {w}
              </div>
            ))}
            {cells.map((c, i) =>
              c === null ? (
                <div key={`blank-${i}`} />
              ) : (
                <DayCell
                  key={c.day}
                  day={c.day}
                  dayNum={c.dayNum}
                  dayType={c.type}
                  note={c.note}
                  isToday={c.day === today}
                />
              )
            )}
          </div>
        </div>

        <p className="mt-3 text-sm text-muted">
          Click any day to change its type. Marking a day{" "}
          <span className="font-medium text-amber-700">extra_working</span> pays every employee an
          extra day and requires an explicit confirmation.
        </p>
      </Section>
    </div>
  );
}

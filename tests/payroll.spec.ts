/**
 * Payroll acceptance tests — 2-STATE model (half-day removed).
 * A day is present (full_day) only if worked_hours >= full_day_hours, else it is
 * absent (full-day leave). leave_units = absent_days. Salary ₹15,000 → daily ₹500,
 * free_leave_units = 1.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { Fixture, getClient, num } from "./helpers";

const SALARY = 15000;
const DAILY = 500;

let db: Client;
let fx: Fixture;

beforeAll(async () => {
  db = getClient();
  await db.connect();
  fx = new Fixture(db);
});

afterAll(async () => {
  await fx.cleanup();
  await db.end();
});

async function run(
  y: number,
  seed: (workerId: string) => Promise<void>,
  opts: { advance?: number } = {}
) {
  const workerId = await fx.createWorker(SALARY);
  const runId = await fx.createRun(`${y}-01-10`, `${y}-02-09`);
  await seed(workerId);
  if (opts.advance) await fx.seedOutstandingAdvance(workerId, opts.advance);
  await fx.compute(runId);
  return {
    line: await fx.line(runId, workerId),
    components: await fx.components(runId, workerId),
    workerId,
    runId,
  };
}

function days(y: number, startDom: number, count: number, status: string) {
  return Array.from({ length: count }, (_, i) => ({
    day: `${y}-01-${String(startDom + i).padStart(2, "0")}`,
    status,
  }));
}

async function seedStatuses(fx: Fixture, workerId: string, list: { day: string; status: string }[]) {
  for (const { day, status } of list) await fx.seedDay(workerId, day, status);
}

describe("payroll acceptance (2-state) — salary ₹15,000, daily ₹500", () => {
  it("1. Perfect attendance → 0 leave, net ₹15,000", async () => {
    const { line } = await run(2090, async (w) => seedStatuses(fx, w, days(2090, 12, 20, "full_day")));
    expect(num(line.leave_units)).toBe(0);
    expect(num(line.net)).toBe(15000);
  });

  it("2. 1 absent (below min hours) → 1 leave, free, net ₹15,000", async () => {
    const { line } = await run(2091, async (w) =>
      seedStatuses(fx, w, [...days(2091, 12, 19, "full_day"), { day: "2091-01-31", status: "absent" }])
    );
    expect(num(line.leave_units)).toBe(1);
    expect(num(line.net)).toBe(15000);
  });

  it("3. 2 absents → 2 leaves, deduction ₹1,000, net ₹14,000", async () => {
    const { line } = await run(2092, async (w) => seedStatuses(fx, w, days(2092, 12, 2, "absent")));
    expect(num(line.leave_units)).toBe(2);
    expect(num(line.net)).toBe(14000);
  });

  it("4. 3 absents → 3 leaves, deduction ₹1,500, net ₹13,500", async () => {
    const { line } = await run(2093, async (w) => seedStatuses(fx, w, days(2093, 12, 3, "absent")));
    expect(num(line.leave_units)).toBe(3);
    expect(num(line.net)).toBe(13500);
  });

  it("5. no half-day column contribution — only absents count as leave", async () => {
    // A short day is recorded as 'absent' by recompute; there is no half state.
    const { line } = await run(2094, async (w) =>
      seedStatuses(fx, w, [...days(2094, 12, 18, "full_day"), ...days(2094, 20, 1, "absent")])
    );
    expect(num(line.half_days)).toBe(0);
    expect(num(line.leave_units)).toBe(1);
    expect(num(line.net)).toBe(15000);
  });

  it("6. Perfect + 1 extra_working day worked → net ₹15,500", async () => {
    const extra = "2098-01-15";
    const { line, components } = await run(2098, async (w) => {
      await fx.setCalendar(extra, "extra_working");
      await seedStatuses(fx, w, days(2098, 12, 2, "full_day"));
      await fx.seedDay(w, extra, "full_day");
    });
    expect(num(line.extra_days)).toBe(1);
    expect(num(line.net)).toBe(15500);
    expect(num(components.find((c) => c.code === "extra_days")!.amount)).toBe(DAILY);
  });

  it("7. Perfect + 1 swapped_working worked → net ₹15,000 (no extra)", async () => {
    const swap = "2099-01-15";
    const { line, components } = await run(2099, async (w) => {
      await fx.setCalendar(swap, "swapped_working");
      await seedStatuses(fx, w, days(2099, 12, 2, "full_day"));
      await fx.seedDay(w, swap, "full_day");
    });
    expect(num(line.extra_days)).toBe(0);
    expect(num(line.net)).toBe(15000);
    expect(components.find((c) => c.code === "extra_days")).toBeFalsy();
  });

  it("8. 12h days, perfect attendance → net ₹15,000 (no OT)", async () => {
    const { line } = await run(2081, async (w) => {
      for (const { day, status } of days(2081, 12, 20, "full_day")) await fx.seedDay(w, day, status, 12);
    });
    expect(num(line.net)).toBe(15000);
  });

  it("9. 2 absents + ₹3,000 advance → deduction ₹1,000, net ₹11,000", async () => {
    const { line, components } = await run(
      2082,
      async (w) => seedStatuses(fx, w, days(2082, 12, 2, "absent")),
      { advance: 3000 }
    );
    expect(num(line.leave_units)).toBe(2);
    expect(num(line.net)).toBe(11000);
    expect(num(components.find((c) => c.code === "advance_recovery")!.amount)).toBe(3000);
  });

  it("10. absence on extra_working is NOT a leave → net ₹15,000", async () => {
    const extra = "2083-01-19";
    const { line } = await run(2083, async (w) => {
      await fx.setCalendar(extra, "extra_working");
      await fx.seedDay(w, extra, "absent");
      await seedStatuses(fx, w, days(2083, 12, 6, "full_day"));
    });
    expect(num(line.absent_days)).toBe(0);
    expect(num(line.net)).toBe(15000);
  });

  it("11. net always equals sum(earnings) − sum(deductions)", async () => {
    const { line, components } = await run(
      2084,
      async (w) => seedStatuses(fx, w, days(2084, 12, 2, "absent")),
      { advance: 1000 }
    );
    const earn = components.filter((c) => c.type === "earning").reduce((s, c) => s + num(c.amount), 0);
    const ded = components.filter((c) => c.type === "deduction").reduce((s, c) => s + num(c.amount), 0);
    expect(num(line.net)).toBe(earn - ded);
  });
});

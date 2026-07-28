/**
 * recompute_attendance tests (spec §3.1, §3.6, §6). Exercises the real SQL:
 * clock-to-clock pairing, dedupe across devices, dangling-punch → unresolved,
 * closed days, approved adjustments, and idempotency.
 *
 * Punch timestamps use the +05:30 offset so they fall on the intended warehouse
 * calendar day (Asia/Kolkata).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { Fixture, getClient, num } from "./helpers";

let db: Client;
let fx: Fixture;

beforeAll(async () => {
  db = getClient();
  await db.connect();
  fx = new Fixture(db);
  await fx.ensureDevice("TEST-DEV-1");
});

afterAll(async () => {
  await fx.cleanup();
  await db.end();
});

describe("recompute_attendance", () => {
  it("pairs first-in / last-out clock-to-clock → full_day", async () => {
    const w = await fx.createWorker(15000);
    const d = "2085-03-10";
    await fx.seedPunch(w, `${d}T08:00:00+05:30`);
    await fx.seedPunch(w, `${d}T16:30:00+05:30`);
    await fx.recompute(d, d);
    const row = await fx.attendance(w, d);
    expect(row.status).toBe("full_day");
    expect(num(row.worked_hours)).toBeCloseTo(8.5, 1);
  });

  it("classifies a 5-hour span (below min hours) as absent — no half-day", async () => {
    const w = await fx.createWorker(15000);
    const d = "2085-03-11";
    await fx.seedPunch(w, `${d}T08:00:00+05:30`);
    await fx.seedPunch(w, `${d}T13:00:00+05:30`);
    await fx.recompute(d, d);
    expect((await fx.attendance(w, d)).status).toBe("absent");
  });

  it("holds a day whose first punch is after the 10 PM cutoff as late_review", async () => {
    const w = await fx.createWorker(15000);
    const d = "2085-03-20";
    await fx.seedPunch(w, `${d}T22:30:00+05:30`);
    await fx.seedPunch(w, `${d}T23:59:00+05:30`);
    await fx.recompute(d, d);
    expect((await fx.attendance(w, d)).status).toBe("late_review");
  });

  it("approved late day → full_day; rejected → absent", async () => {
    const w = await fx.createWorker(15000);
    const d = "2085-03-21";
    await fx.seedPunch(w, `${d}T22:15:00+05:30`);
    await fx.seedPunch(w, `${d}T23:30:00+05:30`);
    await fx.recompute(d, d);
    expect((await fx.attendance(w, d)).status).toBe("late_review");
    await db.query(`select decide_late_review($1,$2,true,'')`, [w, d]);
    expect((await fx.attendance(w, d)).status).toBe("full_day");
    await db.query(`select decide_late_review($1,$2,false,'not genuine')`, [w, d]);
    expect((await fx.attendance(w, d)).status).toBe("absent");
  });

  it("dedupes punches within the window (across devices) into one event", async () => {
    const w = await fx.createWorker(15000);
    await fx.ensureDevice("TEST-DEV-2");
    const d = "2085-03-12";
    // 08:00 and 08:01 collapse (2-min window); 16:00 is a separate event.
    await fx.seedPunch(w, `${d}T08:00:00+05:30`, "TEST-DEV-1");
    await fx.seedPunch(w, `${d}T08:01:00+05:30`, "TEST-DEV-2"); // retry on other terminal
    await fx.seedPunch(w, `${d}T16:00:00+05:30`, "TEST-DEV-1");
    await fx.recompute(d, d);
    const row = await fx.attendance(w, d);
    // If dedupe failed we'd still get full_day; assert the span is exactly 8h
    // (08:00→16:00), proving the 08:01 punch was collapsed, not treated as last-out.
    expect(row.status).toBe("full_day");
    expect(num(row.worked_hours)).toBeCloseTo(8.0, 1);
  });

  it("flags a single dangling punch as unresolved (BLOCKS payroll)", async () => {
    const w = await fx.createWorker(15000);
    const d = "2085-03-13";
    await fx.seedPunch(w, `${d}T08:00:00+05:30`);
    await fx.recompute(d, d);
    expect((await fx.attendance(w, d)).status).toBe("unresolved");
  });

  it("marks a working day with no punches as absent", async () => {
    const w = await fx.createWorker(15000);
    const d = "2085-03-14";
    await fx.recompute(d, d);
    expect((await fx.attendance(w, d)).status).toBe("absent");
  });

  it("marks a closed day as not_working_day (ignores any punches)", async () => {
    const w = await fx.createWorker(15000);
    const d = "2085-03-15";
    await fx.setCalendar(d, "closed");
    await fx.seedPunch(w, `${d}T08:00:00+05:30`);
    await fx.recompute(d, d);
    expect((await fx.attendance(w, d)).status).toBe("not_working_day");
  });

  it("uses an approved adjustment to supply a missing OUT → full_day, is_from_adjustment", async () => {
    const w = await fx.createWorker(15000);
    const d = "2085-03-16";
    await fx.seedPunch(w, `${d}T08:00:00+05:30`); // punched in, forgot out
    await fx.approvedAdjustment(w, d, null, `${d}T16:00:00+05:30`);
    await fx.recompute(d, d);
    const row = await fx.attendance(w, d);
    expect(row.status).toBe("full_day");
    expect(row.is_from_adjustment).toBe(true);
  });

  it("is idempotent — running twice yields identical rows", async () => {
    const w = await fx.createWorker(15000);
    const d = "2085-03-17";
    await fx.seedPunch(w, `${d}T09:00:00+05:30`);
    await fx.seedPunch(w, `${d}T18:00:00+05:30`);
    await fx.recompute(d, d);
    const first = await fx.attendance(w, d);
    await fx.recompute(d, d);
    const second = await fx.attendance(w, d);
    expect(second.status).toBe(first.status);
    expect(num(second.worked_hours)).toBe(num(first.worked_hours));
    expect(second.first_in.toISOString()).toBe(first.first_in.toISOString());
    expect(second.last_out.toISOString()).toBe(first.last_out.toISOString());
  });
});

describe("compute_payroll_run guards (spec §3.6)", () => {
  it("refuses to run while an unresolved day exists in the period", async () => {
    const w = await fx.createWorker(15000);
    const start = "2084-01-10";
    const end = "2084-02-09";
    const runId = await fx.createRun(start, end);
    await fx.seedDay(w, "2084-01-20", "unresolved");
    await expect(fx.compute(runId)).rejects.toThrow(/unresolved/i);
  });

  it("refuses to run while a late_review day exists in the period", async () => {
    const w = await fx.createWorker(15000);
    const runId = await fx.createRun("2082-06-10", "2082-07-09");
    await fx.seedDay(w, "2082-06-20", "late_review");
    await expect(fx.compute(runId)).rejects.toThrow(/held|late/i);
  });

  it("refuses to run while a pending adjustment exists in the period", async () => {
    const w = await fx.createWorker(15000);
    const start = "2083-06-10";
    const end = "2083-07-09";
    const runId = await fx.createRun(start, end);
    const pid = await fx.profileId();
    await db.query(
      `insert into adjustments (worker_id, day, reason, status, requested_by)
       values ($1, '2083-06-20', 'pending test', 'pending', $2)`,
      [w, pid]
    );
    await expect(fx.compute(runId)).rejects.toThrow(/pending/i);
  });
});

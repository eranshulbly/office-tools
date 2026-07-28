/**
 * Integration-test helpers. The payroll/attendance logic lives in Postgres, so
 * these tests connect to the real DB (DATABASE_URL) and exercise the SQL
 * functions directly — this is the source of truth per the build decision.
 *
 * Requires: `npm run db:push` (migrations) and `npm run db:seed` (so at least
 * one profile exists) have been run against the target database.
 *
 * Tests connect as the DB owner, which bypasses RLS — exactly what we want to
 * seed derived tables (attendance_days) directly and assert on the SQL math.
 */
import { Client } from "pg";
import { config } from "dotenv";

config({ path: ".env.local" });

export function getClient(): Client {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set in .env.local — cannot run integration tests");
  return new Client({ connectionString: url });
}

// Unique per run so re-runs never collide with leftover TEST-* workers that
// append-only punches prevented us from deleting.
let seq = 100000 + (Date.now() % 1_000_000_000);
function nextId() {
  return ++seq;
}

/** A tracker so a test can clean up the rows it created. */
export class Fixture {
  workerIds: string[] = [];
  runIds: string[] = [];
  constructor(public db: Client) {}

  async profileId(): Promise<string> {
    const { rows } = await this.db.query("select id from profiles limit 1");
    if (rows[0]) return rows[0].id as string;
    // No profile yet — create a minimal system user so FK constraints hold.
    const created = await this.db.query(
      `with u as (
         insert into auth.users (id, email, aud, role)
         values (gen_random_uuid(), 'test-system@example.com', 'authenticated', 'authenticated')
         returning id
       )
       insert into profiles (id, full_name, role)
       select id, 'Test System', 'admin' from u
       returning id`
    );
    return created.rows[0].id as string;
  }

  async createWorker(salary: number, joinedOn = "2000-01-01"): Promise<string> {
    const code = `TEST-${nextId()}`;
    const { rows } = await this.db.query(
      `insert into workers (employee_code, full_name, device_user_id, monthly_salary, joined_on)
       values ($1, $2, $3, $4, $5) returning id`,
      [code, code, nextId(), salary, joinedOn]
    );
    const id = rows[0].id as string;
    this.workerIds.push(id);
    return id;
  }

  async createRun(periodStart: string, periodEnd: string, payDate?: string): Promise<string> {
    const { rows } = await this.db.query(
      `insert into payroll_runs (period_start, period_end, pay_date)
       values ($1, $2, $3) returning id`,
      [periodStart, periodEnd, payDate ?? periodEnd]
    );
    const id = rows[0].id as string;
    this.runIds.push(id);
    return id;
  }

  async setCalendar(day: string, type: string) {
    await this.db.query(
      `insert into work_calendar (day, day_type) values ($1, $2)
       on conflict (day) do update set day_type = excluded.day_type`,
      [day, type]
    );
  }

  async seedDay(workerId: string, day: string, status: string, hours: number | null = null) {
    await this.db.query(
      `insert into attendance_days (worker_id, day, status, worked_hours, computed_at)
       values ($1, $2, $3, $4, now())
       on conflict (worker_id, day) do update
         set status = excluded.status, worked_hours = excluded.worked_hours, computed_at = now()`,
      [workerId, day, status, hours]
    );
  }

  /** Insert an advance already approved + disbursed + unrecovered. */
  async seedOutstandingAdvance(workerId: string, amount: number) {
    const pid = await this.profileId();
    await this.db.query(
      `insert into advances (worker_id, amount, reason, status, requested_by, decided_by, decided_at, disbursed_at)
       values ($1, $2, 'test advance', 'approved', $3, $3, now(), now())`,
      [workerId, amount, pid]
    );
  }

  async ensureDevice(serial = "TEST-DEV-1") {
    await this.db.query(
      `insert into devices (serial_number, label) values ($1, 'Test device')
       on conflict (serial_number) do nothing`,
      [serial]
    );
    return serial;
  }

  /** device_ts given as an ISO string WITH offset (e.g. 2090-01-20T08:00:00+05:30). */
  async seedPunch(workerId: string, deviceTsIso: string, serial = "TEST-DEV-1") {
    // Unique device_user_id per punch so the (serial, device_user_id, device_ts)
    // dedupe index never collides with leftover append-only punches across runs.
    await this.db.query(
      `insert into raw_punches (device_serial, device_user_id, worker_id, device_ts, raw_line)
       values ($1, $4, $2, $3::timestamptz, 'test')`,
      [serial, workerId, deviceTsIso, nextId()]
    );
  }

  async approvedAdjustment(workerId: string, day: string, proposedIn: string | null, proposedOut: string | null) {
    const pid = await this.profileId();
    await this.db.query(
      `insert into adjustments (worker_id, day, proposed_in, proposed_out, reason, status, requested_by, decided_by, decided_at)
       values ($1, $2, $3::timestamptz, $4::timestamptz, 'test', 'approved', $5, $5, now())`,
      [workerId, day, proposedIn, proposedOut, pid]
    );
  }

  async compute(runId: string) {
    await this.db.query("select compute_payroll_run($1)", [runId]);
  }

  async recompute(from: string, to: string) {
    await this.db.query("select recompute_attendance($1, $2)", [from, to]);
  }

  async line(runId: string, workerId: string) {
    const { rows } = await this.db.query(
      "select * from payroll_lines where run_id = $1 and worker_id = $2",
      [runId, workerId]
    );
    return rows[0];
  }

  async components(runId: string, workerId: string): Promise<Array<{ code: string; type: string; amount: string }>> {
    const { rows } = await this.db.query(
      `select c.code, c.type, c.amount from payroll_line_components c
       join payroll_lines l on l.id = c.line_id
       where l.run_id = $1 and l.worker_id = $2 order by c.code`,
      [runId, workerId]
    );
    return rows;
  }

  async attendance(workerId: string, day: string) {
    const { rows } = await this.db.query(
      "select * from attendance_days where worker_id = $1 and day = $2",
      [workerId, day]
    );
    return rows[0];
  }

  async cleanup() {
    for (const runId of this.runIds) {
      await this.db.query("delete from payroll_runs where id = $1", [runId]).catch(() => {});
    }
    for (const w of this.workerIds) {
      await this.db.query("delete from advances where worker_id = $1", [w]).catch(() => {});
      await this.db.query("delete from adjustments where worker_id = $1", [w]).catch(() => {});
      await this.db.query("delete from attendance_days where worker_id = $1", [w]).catch(() => {});
      // raw_punches is append-only (delete is blocked by trigger); leave it. That
      // pins the worker row too via FK, so only delete workers with no punches.
      await this.db.query("delete from workers where id = $1", [w]).catch(() => {});
    }
  }
}

export function num(x: unknown): number {
  return typeof x === "string" ? parseFloat(x) : (x as number);
}

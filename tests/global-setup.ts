import { config } from "dotenv";
import { Client } from "pg";

config({ path: ".env.local" });

/**
 * Runs once before the test suite. Clears leftover test data so re-runs never
 * collide on the hardcoded far-future test years (>= 2080) or on TEST-* codes
 * (workers pinned by append-only punches are only deactivated, not deleted).
 * Real data (current years) is untouched.
 */
export default async function globalSetup() {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const c = new Client({ connectionString: url });
  await c.connect();
  const q = (sql: string) => c.query(sql).catch(() => {});
  await q(`update advances set recovered_in_run=null where recovered_in_run in (select id from payroll_runs where period_start >= '2050-01-01')`);
  await q(`delete from payroll_runs where period_start >= '2050-01-01'`);
  // Test calendar rows (far-future years) must be cleared too — a leftover
  // extra_working day would wrongly add extra pay to another test's worker.
  await q(`delete from work_calendar where day >= '2050-01-01'`);
  await q(`delete from advances where worker_id in (select id from workers where employee_code like 'TEST-%')`);
  await q(`delete from adjustments where worker_id in (select id from workers where employee_code like 'TEST-%')`);
  await q(`delete from attendance_days where worker_id in (select id from workers where employee_code like 'TEST-%')`);
  await q(`delete from workers where employee_code like 'TEST-%' and id not in (select worker_id from raw_punches where worker_id is not null)`);
  await c.end();
}

/**
 * Verifies that a DELAYED disbursement does not change a period's figures, and
 * that extra days worked in the delay window (after period_end) are NOT added to
 * the previous month — they belong to the next period.
 *
 *   npx tsx scripts/verify-period.ts
 */
import { config } from "dotenv";
import { Client } from "pg";

config({ path: ".env.local" });
const pg = new Client({ connectionString: process.env.DATABASE_URL! });
const num = (x: unknown) => (typeof x === "string" ? parseFloat(x) : (x as number));
let ok = true;
function check(label: string, cond: boolean, detail: string) {
  console.log(`${cond ? "✅" : "❌"} ${label} — ${detail}`);
  if (!cond) ok = false;
}

async function main() {
  await pg.connect();
  const Y = 2065;
  const code = `VP-${Date.now() % 100000}`;
  // clean any prior VP data
  await pg.query(`update advances set recovered_in_run=null where recovered_in_run in (select id from payroll_runs where period_start >= '2065-01-01' and period_start < '2066-01-01')`).catch(() => {});
  await pg.query(`delete from payroll_runs where period_start >= '2065-01-01' and period_start < '2066-01-01'`).catch(() => {});

  const { rows: wr } = await pg.query(
    `insert into workers (employee_code, full_name, device_user_id, monthly_salary, joined_on)
     values ($1,$1,$2,15000,'2000-01-01') returning id`,
    [code, 650000 + (Date.now() % 40000)]
  );
  const w = wr[0].id as string;

  // Calendar: one genuine extra_working day INSIDE the period, and one in the
  // DELAY WINDOW (after period_end, belongs to next period).
  const extraInPeriod = `${Y}-01-19`;      // a Sunday inside 10 Jan–9 Feb
  const extraInDelay = `${Y}-02-12`;       // after 9 Feb — the late-payment window
  await pg.query(`insert into work_calendar(day,day_type) values ($1,'extra_working'),($2,'extra_working')
                  on conflict(day) do update set day_type=excluded.day_type`, [extraInPeriod, extraInDelay]);

  // Attendance: full days in period + attended BOTH extra days.
  for (let d = 12; d <= 18; d++) await pg.query(
    `insert into attendance_days(worker_id,day,status,computed_at) values ($1,$2,'full_day',now())
     on conflict(worker_id,day) do update set status='full_day'`, [w, `${Y}-01-${d}`]);
  await pg.query(`insert into attendance_days(worker_id,day,status,computed_at) values ($1,$2,'full_day',now())
     on conflict(worker_id,day) do update set status='full_day'`, [w, extraInPeriod]);
  await pg.query(`insert into attendance_days(worker_id,day,status,computed_at) values ($1,$2,'full_day',now())
     on conflict(worker_id,day) do update set status='full_day'`, [w, extraInDelay]);

  // Run for 10 Jan–9 Feb, but pay_date is LATE (15 Feb instead of 10 Feb).
  const { rows: rr } = await pg.query(
    `insert into payroll_runs(period_start,period_end,pay_date) values ($1,$2,$3) returning id`,
    [`${Y}-01-10`, `${Y}-02-09`, `${Y}-02-15`]
  );
  const run = rr[0].id as string;

  await pg.query(`select compute_payroll_run($1)`, [run]);
  const { rows: l } = await pg.query(`select * from payroll_lines where run_id=$1 and worker_id=$2`, [run, w]);
  const line = l[0];

  console.log(`\nPeriod 10 Jan – 9 Feb, pay_date 15 Feb (delayed):`);
  check("extra day inside period counted once", num(line.extra_days) === 1, `extra_days=${line.extra_days} (only ${extraInPeriod})`);
  check("delay-window extra day NOT counted here", num(line.extra_days) === 1, `${extraInDelay} excluded (after period_end)`);
  check("net = salary + 1 extra day", num(line.net) === 15500, `net=${line.net} (15000 + 500)`);

  // Freeze, then disburse LATE — figures must not change.
  await pg.query(`select approve_payroll_run($1)`, [run]);
  const netBefore = num((await pg.query(`select net from payroll_lines where id=$1`, [line.id])).rows[0].net);
  await pg.query(`select record_disbursal($1,'cash',null)`, [line.id]);
  const netAfter = num((await pg.query(`select net from payroll_lines where id=$1`, [line.id])).rows[0].net);
  check("late disbursal does not change net", netBefore === netAfter && netAfter === 15500, `net before=${netBefore}, after=${netAfter}`);

  // Next period (10 Feb – 9 Mar): the delay-window extra day belongs HERE.
  const { rows: rr2 } = await pg.query(
    `insert into payroll_runs(period_start,period_end,pay_date) values ($1,$2,$3) returning id`,
    [`${Y}-02-10`, `${Y}-03-09`, `${Y}-03-15`]
  );
  const run2 = rr2[0].id as string;
  await pg.query(`select compute_payroll_run($1)`, [run2]);
  const { rows: l2 } = await pg.query(`select * from payroll_lines where run_id=$1 and worker_id=$2`, [run2, w]);
  check("delay-window extra day lands in NEXT period", num(l2[0].extra_days) === 1, `next run extra_days=${l2[0].extra_days} (${extraInDelay})`);
  check("next period net includes that extra day", num(l2[0].net) === 15500, `net=${l2[0].net}`);

  // cleanup
  await pg.query(`delete from payroll_runs where id in ($1,$2)`, [run, run2]).catch(() => {});
  await pg.query(`delete from attendance_days where worker_id=$1`, [w]).catch(() => {});
  await pg.query(`delete from work_calendar where day in ($1,$2)`, [extraInPeriod, extraInDelay]).catch(() => {});
  await pg.query(`delete from workers where id=$1`, [w]).catch(() => {});

  console.log(`\n${ok ? "✅ ALL CORRECT — delayed disbursement does not affect the period's figures." : "❌ Something is off."}`);
  await pg.end();
  process.exit(0);
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });

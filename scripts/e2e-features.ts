/**
 * Edge-case harness for the new features: worker groups + per-manager disbursal
 * scope, the 10 PM late-review rule, and the 2-state (no half-day) model.
 * Runs REAL flows as admin / manager-1 / manager-2 against the live DB.
 *
 *   npx tsx scripts/e2e-features.ts
 *
 * Test entities are namespaced FT-* and use far-future years (2055–2069).
 */
import { config } from "dotenv";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

config({ path: ".env.local" });
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const findings: { title: string; detail: string }[] = [];
let passes = 0;
const pass = (m: string) => { passes++; console.log(`  ✅ ${m}`); };
const bug = (t: string, d: string) => { findings.push({ title: t, detail: d }); console.log(`  🐛 ${t} — ${d}`); };
const info = (m: string) => console.log(`\n▶ ${m}`);

const pg = new Client({ connectionString: process.env.DATABASE_URL! });
let admin: SupabaseClient, m1: SupabaseClient, m2: SupabaseClient, svc: SupabaseClient;
let m1uid = "", m2uid = "";
let seq = 0;
const uid = () => 500000 + (Date.now() % 40000000) + ++seq;
const num = (x: unknown) => (typeof x === "string" ? parseFloat(x) : (x as number));

async function wipe() {
  await pg.query(`update advances set recovered_in_run=null where recovered_in_run in (select id from payroll_runs where period_start>='2055-01-01' and period_start<'2070-01-01')`).catch(()=>{});
  await pg.query(`delete from payroll_runs where period_start>='2055-01-01' and period_start<'2070-01-01'`).catch(()=>{});
  await pg.query(`delete from late_arrival_reviews where worker_id in (select id from workers where employee_code like 'FT-%')`).catch(()=>{});
  await pg.query(`delete from attendance_days where worker_id in (select id from workers where employee_code like 'FT-%')`).catch(()=>{});
  await pg.query(`update workers set group_id=null where employee_code like 'FT-%'`).catch(()=>{});
  await pg.query(`delete from manager_group_access where group_id in (select id from worker_groups where name like 'FT-GRP-%')`).catch(()=>{});
  await pg.query(`delete from worker_groups where name like 'FT-GRP-%'`).catch(()=>{});
  await pg.query(`delete from workers where employee_code like 'FT-%' and id not in (select worker_id from raw_punches where worker_id is not null)`).catch(()=>{});
}

async function mkWorker(salary: number, groupId: string | null = null) {
  const code = `FT-${uid()}`;
  const { rows } = await pg.query(
    `insert into workers (employee_code, full_name, device_user_id, monthly_salary, joined_on, group_id)
     values ($1,$1,$2,$3,'2000-01-01',$4) returning id`, [code, uid(), salary, groupId]);
  return rows[0].id as string;
}
async function mkGroup(): Promise<string> {
  const { rows } = await pg.query(`insert into worker_groups (name) values ($1) returning id`, [`FT-GRP-${uid()}`]);
  return rows[0].id as string;
}
async function grant(managerUid: string, groupId: string) {
  await pg.query(`insert into manager_group_access (manager_id, group_id) values ($1,$2) on conflict do nothing`, [managerUid, groupId]);
}
async function mkRun(s: string, e: string) {
  const { rows } = await pg.query(`insert into payroll_runs (period_start,period_end,pay_date) values ($1,$2,$2) returning id`, [s, e]);
  return rows[0].id as string;
}
async function seedDay(w: string, day: string, status: string) {
  await pg.query(`insert into attendance_days (worker_id,day,status,computed_at) values ($1,$2,$3,now())
                  on conflict (worker_id,day) do update set status=excluded.status`, [w, day, status]);
}
async function seedPunch(w: string, iso: string) {
  await pg.query(`insert into raw_punches (device_serial,device_user_id,worker_id,device_ts,raw_line) values ('FT-DEV',$2,$1,$3::timestamptz,'ft')`, [w, uid(), iso]);
}
async function line(run: string, w: string) {
  const { rows } = await pg.query(`select * from payroll_lines where run_id=$1 and worker_id=$2`, [run, w]);
  return rows[0];
}
async function att(w: string, day: string) {
  const { rows } = await pg.query(`select status, worked_hours from attendance_days where worker_id=$1 and day=$2`, [w, day]);
  return rows[0];
}

async function approvedRunWith(y: number, workers: string[]) {
  const run = await mkRun(`${y}-01-10`, `${y}-02-09`);
  for (const w of workers) for (let d = 12; d <= 20; d++) await seedDay(w, `${y}-01-${d}`, "full_day");
  await admin.rpc("compute_payroll_run", { p_run_id: run });
  await admin.rpc("approve_payroll_run", { p_run_id: run });
  return run;
}

// ─────────────────────────────────────────────────────────────────────────────

async function scGroupIsolation() {
  info("Groups: disbursal isolation across managers + ungrouped");
  const g1 = await mkGroup(), g2 = await mkGroup();
  await grant(m1uid, g1); await grant(m2uid, g2);
  const w1 = await mkWorker(15000, g1), w2 = await mkWorker(15000, g2), w3 = await mkWorker(15000, null);
  const run = await approvedRunWith(2055, [w1, w2, w3]);
  const l1 = await line(run, w1), l2 = await line(run, w2), l3 = await line(run, w3);

  const { data: m1sees } = await m1.from("payroll_lines").select("worker_id").eq("run_id", run);
  const seenIds = (m1sees ?? []).map((r) => r.worker_id);
  if (seenIds.length === 1 && seenIds[0] === w1) pass("manager-1 sees ONLY their group's line");
  else bug("Manager sees payroll lines outside their groups", `manager-1 saw ${seenIds.length} lines: ${JSON.stringify(seenIds)}`);

  const { error: e1 } = await m1.rpc("record_disbursal", { p_line_id: l1.id, p_mode: "cash", p_reference: null });
  if (!e1) pass("manager-1 disburses their own group's worker"); else bug("Manager cannot disburse own group", e1.message);

  const { error: e2 } = await m1.rpc("record_disbursal", { p_line_id: l2.id, p_mode: "cash", p_reference: null });
  if (e2) pass("manager-1 blocked from disbursing another group"); else bug("Manager can disburse another manager's group", "record_disbursal succeeded on w2 (group 2)");

  const { error: e3 } = await m1.rpc("record_disbursal", { p_line_id: l3.id, p_mode: "cash", p_reference: null });
  if (e3) pass("manager-1 blocked from disbursing ungrouped worker"); else bug("Manager can disburse ungrouped worker", "record_disbursal succeeded on ungrouped w3");

  const { error: e4 } = await admin.rpc("record_disbursal", { p_line_id: l3.id, p_mode: "cash", p_reference: null });
  if (!e4) pass("admin disburses the ungrouped worker"); else bug("Admin cannot disburse ungrouped worker", e4.message);

  // manager-1 self-grants access to group 2?
  const { error: e5 } = await m1.from("manager_group_access").insert({ manager_id: m1uid, group_id: g2 });
  const { rows: chk } = await pg.query(`select 1 from manager_group_access where manager_id=$1 and group_id=$2`, [m1uid, g2]);
  if (e5 || chk.length === 0) pass("manager cannot self-grant group access"); else bug("Manager can grant themselves group access", "inserted manager_group_access for self");

  // manager-1 reads manager-2's access rows?
  const { data: otherAcc } = await m1.from("manager_group_access").select("group_id").eq("manager_id", m2uid);
  if ((otherAcc ?? []).length === 0) pass("manager cannot read another manager's access"); else bug("Manager can read another manager's group access", `saw ${otherAcc!.length} rows`);

  // manager creates a group?
  const { error: e6 } = await m1.from("worker_groups").insert({ name: `FT-GRP-hack-${uid()}` });
  if (e6) pass("manager cannot create worker groups"); else bug("Manager can create worker groups", "insert worker_groups succeeded");

  // manager reassigns a worker's group (to grab access)?
  await m1.from("workers").update({ group_id: g1 }).eq("id", w2);
  const { rows: wg } = await pg.query(`select group_id from workers where id=$1`, [w2]);
  if (wg[0].group_id === g2) pass("manager cannot reassign a worker's group"); else bug("Manager can reassign worker groups", "manager changed workers.group_id");
}

async function scSalaryVisibility() {
  info("Salary + PII visibility outside a manager's group");
  const g = await mkGroup(); await grant(m2uid, g); // m1 has NO access to g
  const w = await mkWorker(77777, g);
  await pg.query(`insert into worker_bank_details (worker_id, bank_account, bank_ifsc) values ($1,'9876543210','HDFC0001') on conflict (worker_id) do update set bank_account=excluded.bank_account`, [w]);

  // Bank details are now admin-only (moved off the workers table) — manager must NOT read them.
  const { data: bank } = await m1.from("worker_bank_details").select("bank_account").eq("worker_id", w);
  if ((bank ?? []).length === 0) pass("manager cannot read bank details (moved to admin-only table)");
  else bug("Manager can still read bank details", `saw ${bank!.length} rows`);

  // Salary stays visible to managers (needed for the unscoped advances cap) — accepted tradeoff.
  const { data } = await m1.from("workers").select("monthly_salary").eq("id", w).maybeSingle();
  console.log(`  ℹ️ salary visible to managers by design (advances cap): manager read monthly_salary=${data ? data.monthly_salary : "n/a"} — kept per the 'advances unscoped' decision`);
}

async function scComponentLeak() {
  info("Payroll component leak: can a manager read another group's salary breakdown?");
  const g1 = await mkGroup(), g2 = await mkGroup();
  await grant(m1uid, g1); await grant(m2uid, g2);
  const w2 = await mkWorker(15000, g2); // belongs to manager-2's group
  const run = await approvedRunWith(2059, [w2]);
  const l2 = await line(run, w2);
  const { data } = await m1.from("payroll_line_components").select("code, amount").eq("line_id", l2.id);
  if ((data ?? []).length === 0) pass("manager cannot read another group's payroll components");
  else bug("Manager can read another group's salary components", `manager-1 read ${data!.length} components of a group-2 line (exposes the salary breakdown)`);
}

async function scCutoffValidation() {
  info("Settings robustness: an invalid text setting value");
  await pg.query(`insert into devices (serial_number,label) values ('FT-DEV','ft') on conflict do nothing`);
  const w = await mkWorker(15000);
  await seedPunch(w, "2060-05-10T09:00:00+05:30"); await seedPunch(w, "2060-05-10T18:00:00+05:30");
  // simulate an admin typo in Settings for the late cutoff
  await pg.query(`update settings set value='"banana"' where key='late_first_punch_cutoff'`);
  const { error } = await admin.rpc("recompute_attendance", { from_date: "2060-05-10", to_date: "2060-05-10" });
  // reset regardless
  await pg.query(`update settings set value='"22:00"' where key='late_first_punch_cutoff'`);
  if (error) {
    bug("An invalid setting value breaks attendance recompute (and thus payroll)",
      `setting late_first_punch_cutoff to a non-time value made recompute_attendance fail ("${error.message}"). Text settings (cutoff, timezone) have no validation, so one Settings typo can brick attendance/payroll for everyone until fixed`);
  } else pass("recompute tolerated the invalid setting");
  // confirm recovery after reset
  const { error: e2 } = await admin.rpc("recompute_attendance", { from_date: "2060-05-10", to_date: "2060-05-10" });
  if (!e2) pass("recompute works again after the setting is corrected");
}

async function scLateEdges() {
  info("Late-punch (10 PM) edges");
  await pg.query(`insert into devices (serial_number,label) values ('FT-DEV','ft') on conflict do nothing`);

  // 7h exactly → present
  const w1 = await mkWorker(15000);
  await seedPunch(w1, "2056-05-10T08:00:00+05:30"); await seedPunch(w1, "2056-05-10T15:00:00+05:30");
  await admin.rpc("recompute_attendance", { from_date: "2056-05-10", to_date: "2056-05-10" });
  if ((await att(w1, "2056-05-10")).status === "full_day") pass("exactly 7h → full_day"); else bug("7h boundary wrong", (await att(w1, "2056-05-10")).status);

  // 6h → absent
  const w2 = await mkWorker(15000);
  await seedPunch(w2, "2056-05-11T08:00:00+05:30"); await seedPunch(w2, "2056-05-11T14:00:00+05:30");
  await admin.rpc("recompute_attendance", { from_date: "2056-05-11", to_date: "2056-05-11" });
  if ((await att(w2, "2056-05-11")).status === "absent") pass("6h (below min) → absent"); else bug("Below-min not absent", (await att(w2, "2056-05-11")).status);

  // two punches, first after 22:00 → late_review
  const w3 = await mkWorker(15000);
  await seedPunch(w3, "2056-05-12T22:30:00+05:30"); await seedPunch(w3, "2056-05-12T23:30:00+05:30");
  await admin.rpc("recompute_attendance", { from_date: "2056-05-12", to_date: "2056-05-12" });
  if ((await att(w3, "2056-05-12")).status === "late_review") pass("first punch after 22:00 → late_review"); else bug("Late hold not applied", (await att(w3, "2056-05-12")).status);

  // SINGLE punch after 22:00 → what happens?
  const w4 = await mkWorker(15000);
  await seedPunch(w4, "2056-05-13T23:00:00+05:30");
  await admin.rpc("recompute_attendance", { from_date: "2056-05-13", to_date: "2056-05-13" });
  const s4 = (await att(w4, "2056-05-13")).status;
  if (s4 === "late_review") pass("single late punch → late_review");
  else bug("Single late punch is NOT caught by the 10 PM rule", `a lone punch at 23:00 became '${s4}' (dangling/unresolved), not 'late_review' — a worker who only badges in after 10 PM slips past the late-review hold`);

  // manager can decide a late review?
  const { error: mErr } = await m1.rpc("decide_late_review", { p_worker: w3, p_day: "2056-05-12", p_approve: true, p_reason: "" });
  if (mErr) pass("manager blocked from deciding late reviews"); else bug("Manager can decide late reviews", "decide_late_review succeeded as manager");

  // manager can insert late_arrival_reviews directly?
  const { error: insErr } = await m1.from("late_arrival_reviews").insert({ worker_id: w3, day: "2056-05-12", status: "approved" });
  const { rows: lr } = await pg.query(`select status from late_arrival_reviews where worker_id=$1 and day=$2`, [w3, "2056-05-12"]);
  if (insErr || !lr[0] || lr[0].status !== "approved") pass("manager cannot write late_arrival_reviews directly"); else bug("Manager can write late-review decisions directly", "insert late_arrival_reviews as manager succeeded");

  // admin approve → full_day (present even though it's a short/late day); reject → absent
  await admin.rpc("decide_late_review", { p_worker: w3, p_day: "2056-05-12", p_approve: true, p_reason: "" });
  if ((await att(w3, "2056-05-12")).status === "full_day") pass("approved late day → full_day (present)"); else bug("Approved late day not present", (await att(w3, "2056-05-12")).status);
  await admin.rpc("decide_late_review", { p_worker: w3, p_day: "2056-05-12", p_approve: false, p_reason: "not genuine" });
  if ((await att(w3, "2056-05-12")).status === "absent") pass("rejected late day → absent"); else bug("Rejected late day not absent", (await att(w3, "2056-05-12")).status);
}

async function scGroupReassignMidRun() {
  info("Group reassignment after a run is approved (disbursal responsibility)");
  const g1 = await mkGroup(), g2 = await mkGroup();
  await grant(m1uid, g1); await grant(m2uid, g2);
  const w = await mkWorker(15000, g1);
  const run = await approvedRunWith(2057, [w]);
  const l = await line(run, w);
  // admin moves the worker to g2 AFTER approval
  await pg.query(`update workers set group_id=$1 where id=$2`, [g2, w]);
  const { error } = await m1.rpc("record_disbursal", { p_line_id: l.id, p_mode: "cash", p_reference: null });
  if (error) {
    bug("Group change retroactively removes disbursal access on an APPROVED run",
      "worker was in manager-1's group when the run was approved; admin moved them to another group and manager-1 can no longer disburse their frozen line — disbursal scope is evaluated on the CURRENT group, not the group at approval time");
  } else pass("approved-run disbursal unaffected by later group change");
}

async function scManagerPrivileges() {
  info("Manager privilege boundaries on new tables");
  const g = await mkGroup();
  const { error: e1 } = await m1.from("worker_groups").update({ name: "hacked" }).eq("id", g);
  const { rows: gr } = await pg.query(`select name from worker_groups where id=$1`, [g]);
  if (e1 || gr[0].name !== "hacked") pass("manager cannot rename groups"); else bug("Manager can rename worker groups", "update worker_groups succeeded");

  // manager tampering payroll_lines directly (regression of the RLS drop)
  const w = await mkWorker(15000, g); await grant(m1uid, g);
  const run = await approvedRunWith(2058, [w]);
  const l = await line(run, w);
  await m1.from("payroll_lines").update({ net: 1 }).eq("id", l.id);
  const after = await line(run, w);
  if (num(after.net) !== 1) pass("manager still cannot tamper payroll figures"); else bug("Manager can tamper payroll figures", "direct UPDATE payroll_lines.net succeeded");
}

async function scMoreGroupCases() {
  info("More group cases: multi-group, shared group, admin-ungrouped, bank/mga writes");
  const gA = await mkGroup(), gB = await mkGroup();
  // manager-1 in BOTH gA and gB; manager-2 also in gA (shared)
  await grant(m1uid, gA); await grant(m1uid, gB); await grant(m2uid, gA);
  const wA = await mkWorker(15000, gA), wB = await mkWorker(15000, gB), wU = await mkWorker(15000, null);
  const run = await approvedRunWith(2061, [wA, wB, wU]);
  const lA = await line(run, wA), lB = await line(run, wB), lU = await line(run, wU);

  // multi-group manager sees BOTH their groups' lines, and NOT the ungrouped one.
  const { data: m1sees } = await m1.from("payroll_lines").select("worker_id").eq("run_id", run);
  const ids = new Set((m1sees ?? []).map((r) => r.worker_id));
  if (ids.has(wA) && ids.has(wB) && !ids.has(wU)) pass("multi-group manager sees both groups' lines, not the ungrouped one"); else bug("Multi-group visibility wrong", `wA=${ids.has(wA)} wB=${ids.has(wB)} wU(should be false)=${ids.has(wU)}`);

  // shared group: manager-2 (gA) can also disburse wA — but only until it's paid once
  const { error: e2a } = await m2.rpc("record_disbursal", { p_line_id: lA.id, p_mode: "cash", p_reference: null });
  if (!e2a) pass("shared-group manager can disburse the shared group's worker"); else bug("Shared-group disbursal blocked", e2a.message);

  // admin can disburse the ungrouped line
  const { error: eu } = await admin.rpc("record_disbursal", { p_line_id: lU.id, p_mode: "cash", p_reference: null });
  if (!eu) pass("admin disburses ungrouped line"); else bug("Admin cannot disburse ungrouped line", eu.message);
  // manager-1 cannot disburse the ungrouped line
  const { error: emu } = await m1.rpc("record_disbursal", { p_line_id: lU.id, p_mode: "cash", p_reference: null });
  if (emu) pass("manager cannot disburse ungrouped line"); else bug("Manager disbursed ungrouped line", "should be admin-only");

  // manager cannot delete their own group access
  await m1.from("manager_group_access").delete().eq("manager_id", m1uid).eq("group_id", gB);
  const { rows: still } = await pg.query(`select 1 from manager_group_access where manager_id=$1 and group_id=$2`, [m1uid, gB]);
  if (still.length === 1) pass("manager cannot delete their own access"); else bug("Manager can delete their group access", "self-service access removal");

  // manager cannot read or write bank details even for their own group
  const w = wA;
  await pg.query(`insert into worker_bank_details (worker_id, bank_account) values ($1,'111') on conflict (worker_id) do nothing`, [w]);
  const { data: br } = await m1.from("worker_bank_details").select("bank_account").eq("worker_id", w);
  if ((br ?? []).length === 0) pass("manager cannot read bank of their own group's worker"); else bug("Manager reads own-group bank details", "bank should be admin-only");
  await m1.from("worker_bank_details").update({ bank_account: "hacked" }).eq("worker_id", w);
  const { rows: ba } = await pg.query(`select bank_account from worker_bank_details where worker_id=$1`, [w]);
  if (ba[0].bank_account !== "hacked") pass("manager cannot write bank details"); else bug("Manager can write bank details", "update worker_bank_details succeeded");
  void lB;
}

async function scCutoffBoundary() {
  info("Cutoff boundary: 22:00:00 exact vs 22:00:01");
  await pg.query(`insert into devices (serial_number,label) values ('FT-DEV','ft') on conflict do nothing`);
  const w1 = await mkWorker(15000);
  await seedPunch(w1, "2062-04-10T22:00:00+05:30"); await seedPunch(w1, "2062-04-10T23:30:00+05:30");
  await admin.rpc("recompute_attendance", { from_date: "2062-04-10", to_date: "2062-04-10" });
  const s1 = (await att(w1, "2062-04-10")).status;
  if (s1 !== "late_review") pass(`first punch exactly at 22:00 is NOT late (status ${s1})`); else bug("22:00:00 treated as late", "cutoff should be strict (> cutoff)");

  const w2 = await mkWorker(15000);
  await seedPunch(w2, "2062-04-11T22:00:01+05:30"); await seedPunch(w2, "2062-04-11T23:30:00+05:30");
  await admin.rpc("recompute_attendance", { from_date: "2062-04-11", to_date: "2062-04-11" });
  if ((await att(w2, "2062-04-11")).status === "late_review") pass("first punch at 22:00:01 → late_review"); else bug("Just-after-cutoff not late", (await att(w2, "2062-04-11")).status);
}

async function scAdvanceHandoverScope() {
  info("Advance cash-handover scope (is it group-scoped like salary?)");
  const g = await mkGroup(); await grant(m2uid, g); // m1 has NO access to g
  const w = await mkWorker(15000, g);
  const { data: adv } = await m1.from("advances").insert({ worker_id: w, amount: 500, reason: "ft", requested_by: m1uid }).select("id").single();
  await admin.rpc("decide_advance", { p_id: adv!.id, p_approve: true, p_reason: "" });
  const { error } = await m1.rpc("record_advance_disbursal", { p_id: adv!.id });
  if (!error) {
    bug("Advance cash-handover is NOT group-scoped",
      "manager-1 recorded the cash handover for an advance belonging to a worker OUTSIDE manager-1's groups — salary disbursal is group-scoped but advance handover is not. May be intended (advances were kept unscoped), flagging for your decision");
  } else pass("advance handover is group-scoped");
}

async function scWorkerOnboarding() {
  info("Employee onboarding: manager add → admin approve; manager edit → admin approve");
  const g = await mkGroup(); await grant(m1uid, g);
  const gOther = await mkGroup(); await grant(m2uid, gOther);

  // manager-1 adds a new worker into their group
  const code = `FT-NW-${uid()}`;
  const { data: nw, error: nwErr } = await m1.rpc("request_new_worker", {
    p: { employee_code: code, full_name: "New Hire", device_user_id: String(uid()), joined_on: "2060-01-01", phone: "+9199", group_id: g },
  });
  if (nwErr) { bug("Manager cannot add a worker", nwErr.message); return; }
  const wid = nw as string;
  const { rows: s1 } = await pg.query(`select approval_status, is_active, monthly_salary from workers where id=$1`, [wid]);
  if (s1[0].approval_status === "pending" && s1[0].is_active === false && s1[0].monthly_salary === null)
    pass("new worker is pending, inactive, no salary"); else bug("New worker state wrong", JSON.stringify(s1[0]));

  // cannot add into a group they don't own
  const { error: e2 } = await m1.rpc("request_new_worker", {
    p: { employee_code: `FT-NW2-${uid()}`, full_name: "X", device_user_id: String(uid()), joined_on: "2060-01-01", group_id: gOther },
  });
  if (e2) pass("manager cannot add into a group they don't own"); else bug("Manager added to a foreign group", "succeeded");

  // manager cannot approve
  const { error: e3 } = await m1.rpc("approve_new_worker", { p_worker: wid, p_salary: 15000, p_bank_account: null, p_bank_ifsc: null });
  if (e3) pass("manager blocked from approving a new worker"); else bug("Manager can approve a new worker", "succeeded");

  // admin approves with salary + bank
  const { error: e4 } = await admin.rpc("approve_new_worker", { p_worker: wid, p_salary: 15000, p_bank_account: "111222", p_bank_ifsc: "HDFC0009" });
  if (e4) bug("Admin cannot approve new worker", e4.message);
  const { rows: s2 } = await pg.query(`select approval_status, is_active, monthly_salary from workers where id=$1`, [wid]);
  if (s2[0].approval_status === "active" && s2[0].is_active === true && Number(s2[0].monthly_salary) === 15000)
    pass("approved → active with salary set"); else bug("Approval didn't activate/set salary", JSON.stringify(s2[0]));
  const { rows: bk } = await pg.query(`select bank_account from worker_bank_details where worker_id=$1`, [wid]);
  if (bk[0]?.bank_account === "111222") pass("bank details saved on approval"); else bug("Bank not saved on approval", JSON.stringify(bk));
  const { data: mbk } = await m1.from("worker_bank_details").select("bank_account").eq("worker_id", wid);
  if ((mbk ?? []).length === 0) pass("manager still cannot read the bank details"); else bug("Manager reads bank", "leak");

  // manager proposes an edit → pending, worker unchanged
  const { data: er, error: erErr } = await m1.rpc("request_worker_edit", { p_worker: wid, p: { full_name: "New Hire Renamed", phone: "+9188" } });
  if (erErr) bug("Manager cannot propose an edit", erErr.message);
  const { rows: s3 } = await pg.query(`select full_name from workers where id=$1`, [wid]);
  if (s3[0].full_name === "New Hire") pass("proposed edit is pending — worker unchanged"); else bug("Edit applied immediately", s3[0].full_name);

  // admin approves the edit → applied
  const { error: e6 } = await admin.rpc("decide_worker_edit", { p_id: er, p_approve: true, p_reason: "" });
  if (e6) bug("decide_worker_edit failed", e6.message);
  const { rows: s4 } = await pg.query(`select full_name, phone from workers where id=$1`, [wid]);
  if (s4[0].full_name === "New Hire Renamed" && s4[0].phone === "+9188") pass("approved edit applied to the worker"); else bug("Edit not applied on approval", JSON.stringify(s4[0]));

  // manager-2 cannot propose an edit for manager-1's worker
  const { error: e7 } = await m2.rpc("request_worker_edit", { p_worker: wid, p: { full_name: "hax" } });
  if (e7) pass("manager cannot edit a worker outside their groups"); else bug("Manager edited a foreign worker", "succeeded");
}

async function main() {
  await pg.connect();
  svc = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  admin = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  m1 = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

  const a = await admin.auth.signInWithPassword({ email: process.env.SEED_ADMIN_EMAIL!, password: process.env.SEED_ADMIN_PASSWORD! });
  const m = await m1.auth.signInWithPassword({ email: process.env.SEED_MANAGER_EMAIL!, password: process.env.SEED_MANAGER_PASSWORD! });
  if (a.error || m.error) throw new Error("login failed: " + (a.error?.message || m.error?.message));
  m1uid = m.data.user!.id;

  // second manager
  const m2email = "ft-manager2@warehouse.local", m2pass = "FtM2pass@1";
  const listed = await svc.auth.admin.listUsers({ page: 1, perPage: 200 });
  let hit = listed.data.users.find((u) => u.email === m2email);
  if (!hit) hit = (await svc.auth.admin.createUser({ email: m2email, password: m2pass, email_confirm: true })).data.user!;
  m2uid = hit.id;
  await svc.from("profiles").upsert({ id: m2uid, full_name: "FT Manager 2", role: "manager" });
  m2 = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  await m2.auth.signInWithPassword({ email: m2email, password: m2pass });
  console.log(`signed in: admin, manager1=${m1uid.slice(0,8)}, manager2=${m2uid.slice(0,8)}`);

  await wipe();
  for (const s of [scGroupIsolation, scSalaryVisibility, scComponentLeak, scLateEdges, scGroupReassignMidRun, scManagerPrivileges, scCutoffValidation, scMoreGroupCases, scCutoffBoundary, scAdvanceHandoverScope, scWorkerOnboarding]) {
    try { await s(); } catch (e) { bug(`Scenario threw: ${s.name}`, e instanceof Error ? e.message : String(e)); }
  }
  await wipe();
  await svc.auth.admin.deleteUser(m2uid).catch(() => {});

  console.log(`\n${"═".repeat(64)}`);
  console.log(`RESULTS: ${passes} checks passed, ${findings.length} finding(s)`);
  console.log("═".repeat(64));
  findings.forEach((f, i) => console.log(`\n${i + 1}. ${f.title}\n   ${f.detail}`));
  await pg.end();
  process.exit(0);
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });

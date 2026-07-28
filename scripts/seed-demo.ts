/**
 * seed-demo.ts — populate demo data: groups, employees randomly assigned to
 * groups, and one manager login per group (group-scoped disbursal).
 *
 *   npx tsx scripts/seed-demo.ts
 *
 * Employees are namespaced EMP-* so they're easy to spot / clean up later.
 * Re-runnable-ish: groups upsert by name; employees are created fresh each run
 * with unique codes/PINs.
 */
import { config } from "dotenv";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

config({ path: ".env.local" });
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const GROUPS = ["Backend Staff", "Pickers", "Packers"];
const FIRST = ["Rajesh", "Priya", "Amit", "Sunita", "Vikram", "Anjali", "Deepak", "Kavita", "Suresh", "Meena", "Arjun", "Pooja", "Ravi", "Neha", "Manoj", "Rekha", "Sanjay", "Divya", "Karan", "Nisha", "Gaurav", "Shalini"];
const LAST = ["Sharma", "Verma", "Yadav", "Gupta", "Singh", "Nair", "Reddy", "Iyer", "Das", "Patel", "Kumar", "Mishra"];

const EMPLOYEE_COUNT = 18;
const MANAGER_PASSWORD = "Manager@123";

const rand = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const randInt = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));

async function findUser(svc: SupabaseClient, email: string) {
  let page = 1;
  for (;;) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) return null;
    page++;
  }
}

async function main() {
  const pg = new Client({ connectionString: process.env.DATABASE_URL! });
  await pg.connect();
  const svc = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

  // 1) Groups (upsert by name) → id map
  const groupId = new Map<string, string>();
  for (const name of GROUPS) {
    const { rows } = await pg.query(
      `insert into worker_groups (name) values ($1)
       on conflict (name) do update set name = excluded.name
       returning id`,
      [name]
    );
    groupId.set(name, rows[0].id);
  }
  console.log(`groups ready: ${GROUPS.join(", ")}`);

  // 2) Assign any existing ungrouped ACTIVE employees to a random group.
  const { rows: ungrouped } = await pg.query(
    `select id from workers where is_active = true and group_id is null and approval_status = 'active'`
  );
  for (const w of ungrouped) {
    await pg.query(`update workers set group_id = $1 where id = $2`, [groupId.get(rand(GROUPS))!, w.id]);
  }
  if (ungrouped.length) console.log(`assigned ${ungrouped.length} existing employee(s) to groups`);

  // 3) Create demo employees, random group, active + approved.
  // PIN base above anything already used to avoid unique collisions.
  const { rows: maxPinRow } = await pg.query(`select coalesce(max(device_user_id), 2000) as m from workers where device_user_id < 100000`);
  let pin = Math.max(Number(maxPinRow[0].m), 2000) + 1;
  const perGroup = new Map<string, number>(GROUPS.map((g) => [g, 0]));
  const stamp = Date.now().toString().slice(-5);

  for (let i = 1; i <= EMPLOYEE_COUNT; i++) {
    const name = `${rand(FIRST)} ${rand(LAST)}`;
    const g = rand(GROUPS);
    perGroup.set(g, (perGroup.get(g) ?? 0) + 1);
    const salary = randInt(24, 50) * 500; // 12,000 – 25,000
    const joined = `${randInt(2024, 2025)}-${String(randInt(1, 12)).padStart(2, "0")}-${String(randInt(1, 28)).padStart(2, "0")}`;
    const code = `EMP-${stamp}-${String(i).padStart(2, "0")}`;
    await pg.query(
      `insert into workers (employee_code, full_name, device_user_id, monthly_salary, joined_on, group_id, is_active, approval_status)
       values ($1,$2,$3,$4,$5,$6,true,'active')`,
      [code, name, pin++, salary, joined, groupId.get(g)]
    );
  }
  console.log(`created ${EMPLOYEE_COUNT} demo employees:`, Object.fromEntries(perGroup));

  // 4) One manager login per group, scoped to that group.
  const managers = [
    { name: "Backend Manager", email: "backend.manager@warehouse.local", group: "Backend Staff" },
    { name: "Pickers Manager", email: "pickers.manager@warehouse.local", group: "Pickers" },
    { name: "Packers Manager", email: "packers.manager@warehouse.local", group: "Packers" },
  ];
  for (const m of managers) {
    let user = await findUser(svc, m.email);
    if (!user) {
      const { data, error } = await svc.auth.admin.createUser({
        email: m.email,
        password: MANAGER_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: m.name },
      });
      if (error) throw error;
      user = data.user;
    }
    await svc.from("profiles").upsert({ id: user!.id, full_name: m.name, role: "manager" }, { onConflict: "id" });
    await pg.query(
      `insert into manager_group_access (manager_id, group_id) values ($1,$2) on conflict do nothing`,
      [user!.id, groupId.get(m.group)]
    );
    console.log(`  manager ${m.email} → ${m.group}`);
  }

  await pg.end();
  console.log(`\n✔ demo seeded. Manager logins (password: ${MANAGER_PASSWORD}):`);
  managers.forEach((m) => console.log(`   ${m.email}  (manages ${m.group})`));
  process.exit(0);
}
main().catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });

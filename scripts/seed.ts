/**
 * seed.ts — create the admin + manager auth users and their profiles, plus a
 * little sample data (devices, workers) so the app is usable immediately.
 *
 *   npm run db:seed
 *
 * Idempotent-ish: re-running finds existing users by email and reuses them.
 * Uses the service_role key (bypasses RLS) — server-only, never shipped.
 */
import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function findUserByEmail(sb: SupabaseClient, email: string) {
  // list users pages until found (fine for a handful of accounts)
  let page = 1;
  for (;;) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) return null;
    page += 1;
  }
}

async function ensureUser(email: string, password: string, fullName: string, role: "admin" | "manager") {
  if (!password) throw new Error(`Missing password for ${email} — set it in .env.local`);

  let user = await findUserByEmail(admin, email);
  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error) throw error;
    user = data.user;
    console.log(`+ created auth user ${email}`);
  } else {
    console.log(`= auth user ${email} already exists`);
  }

  const { error: pErr } = await admin
    .from("profiles")
    .upsert({ id: user.id, full_name: fullName, role }, { onConflict: "id" });
  if (pErr) throw pErr;
  console.log(`  profile → ${role}`);
  return user;
}

async function seedSampleData() {
  // Two K40 Pro terminals at one gate.
  const { error: dErr } = await admin.from("devices").upsert(
    [
      { serial_number: "K40PRO-A0001", label: "Gate — Terminal 1", is_active: true },
      { serial_number: "K40PRO-A0002", label: "Gate — Terminal 2", is_active: true },
    ],
    { onConflict: "serial_number" }
  );
  if (dErr) throw dErr;

  const workers = [
    { employee_code: "W-001", full_name: "Ramesh Kumar",  device_user_id: 1001, monthly_salary: 15000, joined_on: "2025-01-01" },
    { employee_code: "W-002", full_name: "Sita Devi",     device_user_id: 1002, monthly_salary: 18000, joined_on: "2025-03-15" },
    { employee_code: "W-003", full_name: "Abdul Rahman",  device_user_id: 1003, monthly_salary: 16500, joined_on: "2024-11-01" },
    { employee_code: "W-004", full_name: "Lakshmi Nair",  device_user_id: 1004, monthly_salary: 20000, joined_on: "2025-06-01" },
  ];
  const { error: wErr } = await admin.from("workers").upsert(workers, { onConflict: "employee_code" });
  if (wErr) throw wErr;
  console.log(`  sample: 2 devices, ${workers.length} workers`);
}

async function main() {
  try {
    await ensureUser(
      process.env.SEED_ADMIN_EMAIL || "admin@warehouse.local",
      process.env.SEED_ADMIN_PASSWORD || "",
      "Warehouse Admin",
      "admin"
    );
    await ensureUser(
      process.env.SEED_MANAGER_EMAIL || "manager@warehouse.local",
      process.env.SEED_MANAGER_PASSWORD || "",
      "Warehouse Manager",
      "manager"
    );
    await seedSampleData();
    console.log("✔ seed complete");
  } catch (err) {
    console.error("✗ seed failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

main();

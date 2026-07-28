/**
 * db-push.ts — apply SQL migrations to the Supabase Postgres in order.
 *
 *   npm run db:push            apply supabase/migrations/*.sql (idempotent)
 *   npm run db:reset           tear down our objects, then apply everything
 *
 * Uses DATABASE_URL from .env.local. Migrations are plain multi-statement SQL.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { Client } from "pg";

config({ path: ".env.local" });

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "supabase", "migrations");

// Our objects only — never touches Supabase-managed schemas.
const TEARDOWN = `
do $$ begin
  drop table if exists
    payroll_line_components, payroll_lines, payroll_runs,
    advances, adjustments, attendance_days, raw_punches,
    work_calendar, devices, workers, settings, audit_log, profiles
  cascade;
  drop type if exists
    pay_mode, run_status, component_type, request_status,
    day_status, calendar_day_type, user_role
  cascade;
end $$;
`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Fill it in .env.local (Supabase → Database → Connection string).");
    process.exit(1);
  }

  const reset = process.argv.includes("--reset");
  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    if (reset) {
      console.log("↺ tearing down existing objects…");
      await client.query(TEARDOWN);
    }

    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      process.stdout.write(`→ applying ${file} … `);
      await client.query(sql);
      console.log("ok");
    }
    console.log("✔ migrations applied");
  } catch (err) {
    console.error("\n✗ migration failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();

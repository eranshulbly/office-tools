/**
 * seed.ts — create the admin + manager accounts on a fresh MySQL database.
 *
 *   npm run db:seed
 *
 * Idempotent: re-running updates the existing accounts' password and role
 * rather than failing on the unique email.
 *
 * Ported from the Supabase version, which used the service_role key to call
 * auth.admin.createUser. The app owns its own auth table now, so accounts are
 * written directly — auth_users + profiles together, in a transaction.
 */
import { config } from "dotenv";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";

config({ path: ".env.local" });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Fill it in .env.local (mysql://user:pass@host:3306/db).");
  process.exit(1);
}
// Guard against being pointed at the retired Postgres URL by accident.
if (!url.startsWith("mysql://")) {
  console.error(`DATABASE_URL is not a MySQL URL (got "${url.split("://")[0]}://…").`);
  process.exit(1);
}

const ACCOUNTS = [
  {
    email: process.env.SEED_ADMIN_EMAIL ?? "admin@warehouse.local",
    password: process.env.SEED_ADMIN_PASSWORD,
    fullName: "Warehouse Admin",
    role: "admin",
  },
  {
    email: process.env.SEED_MANAGER_EMAIL ?? "manager@warehouse.local",
    password: process.env.SEED_MANAGER_PASSWORD,
    fullName: "Manager",
    role: "manager",
  },
];

async function main(): Promise<void> {
  const missing = ACCOUNTS.filter((a) => !a.password).map((a) => a.role.toUpperCase());
  if (missing.length) {
    console.error(`Set ${missing.map((r) => `SEED_${r}_PASSWORD`).join(" and ")} in .env.local.`);
    process.exit(1);
  }

  const conn = await mysql.createConnection(url as string);
  try {
    for (const a of ACCOUNTS) {
      const email = a.email.trim().toLowerCase();
      const hash = await bcrypt.hash(a.password as string, 10);

      const [rows] = await conn.query("SELECT id FROM auth_users WHERE email = ? LIMIT 1", [email]);
      let id = (rows as { id: string }[])[0]?.id;

      // The two rows are written together: an auth_users row with no profile is
      // a login that resolves to no role.
      await conn.beginTransaction();
      try {
        if (id) {
          await conn.query("UPDATE auth_users SET encrypted_password = ? WHERE id = ?", [hash, id]);
        } else {
          id = randomUUID();
          await conn.query(
            "INSERT INTO auth_users (id, email, encrypted_password) VALUES (?, ?, ?)",
            [id, email, hash]
          );
        }
        await conn.query(
          `INSERT INTO profiles (id, full_name, role) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), role = VALUES(role)`,
          [id, a.fullName, a.role]
        );
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      }
      console.log(`  ${a.role.padEnd(7)} ${email}`);
    }
    console.log("\nSeed complete. Sign in with the passwords from .env.local.");
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

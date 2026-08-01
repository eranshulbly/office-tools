import { createDbClient, createDbServiceClient, type DbClient } from "@/lib/db/client";

/**
 * MySQL-backed replacement for the Supabase server client.
 *
 * The name is kept so the 52 files that import it keep working; only the
 * implementation changed. Once every call site has been reviewed against MySQL
 * this should be renamed to something honest like `createDbClient` — until
 * then, a rename would just add churn to a migration that already touches a lot.
 *
 * IMPORTANT — what changed underneath:
 * Postgres RLS used to be the real authorization boundary; every query ran as
 * the logged-in user and the database filtered rows. MySQL has no equivalent,
 * so a query issued through this client is NOT filtered by role. Permission
 * checks now have to be explicit in the calling code. Treat anything reading
 * salaries, advances or payroll as unguarded until it has been given one.
 */
export async function createSupabaseServerClient(): Promise<DbClient> {
  return createDbClient();
}

/** Formerly the service-role client; bypasses no RLS because there is none. */
export function createSupabaseServiceClient(): DbClient {
  return createDbServiceClient();
}

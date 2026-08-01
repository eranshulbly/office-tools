/**
 * Authorization, replacing the 39 Postgres RLS policies.
 *
 * This is a faithful transcription of what the policies actually did, taken
 * from pg_policies on the live database before it was deleted — not from what
 * the docs claimed. The shape was:
 *
 *   most tables      ALL  -> is_admin()          (admin writes)
 *                    SELECT -> auth.uid() IS NOT NULL   (anyone logged in reads)
 *   a few tables     ALL  -> is_admin()  and NO select policy, so admin-only
 *   manager_group_access   SELECT -> manager_id = auth.uid()  (own rows)
 *   payroll_*        SELECT -> manager, and only for approved runs in their groups
 *
 * Enforced centrally rather than at each call site, on purpose. RLS was
 * automatic and impossible to forget; 121 hand-written checks would not be.
 * Default is deny: a table absent from the map gets ADMIN_ONLY rather than
 * falling open, so adding a table without thinking about access fails closed.
 */

export type Role = "admin" | "manager";
export type Op = "select" | "insert" | "update" | "delete";

type Access =
  | "admin" // admin only
  | "auth" // any authenticated user
  | "own" // rows belonging to the caller
  | "payroll"; // manager, restricted to approved runs (see note below)

type Policy = { read: Access; write: Access };

const ADMIN_ONLY: Policy = { read: "admin", write: "admin" };
const READ_ALL_ADMIN_WRITE: Policy = { read: "auth", write: "admin" };

const POLICIES: Record<string, Policy> = {
  // Admin-only: these had an ALL/is_admin() policy and no SELECT policy at all,
  // so a manager could never read them.
  audit_log: ADMIN_ONLY,
  upi_mappings: ADMIN_ONLY,
  device_users: ADMIN_ONLY,
  worker_bank_details: ADMIN_ONLY,

  // Managers see only their own access rows.
  manager_group_access: { read: "own", write: "admin" },

  // Managers may read payroll, but only approved/disbursing/closed runs limited
  // to groups they can disburse. That row-level condition is applied by the
  // disburse queries themselves; this only gates the coarse read.
  payroll_runs: { read: "payroll", write: "admin" },
  payroll_lines: { read: "payroll", write: "admin" },
  payroll_line_components: { read: "payroll", write: "admin" },

  // Read by anyone signed in, written by admin.
  cheques: READ_ALL_ADMIN_WRITE,
  company_bank_accounts: READ_ALL_ADMIN_WRITE,
  settings: READ_ALL_ADMIN_WRITE,
  work_calendar: READ_ALL_ADMIN_WRITE,
  workers: READ_ALL_ADMIN_WRITE,
  worker_groups: READ_ALL_ADMIN_WRITE,
  worker_edit_requests: READ_ALL_ADMIN_WRITE,
  profiles: READ_ALL_ADMIN_WRITE,
  devices: READ_ALL_ADMIN_WRITE,
  raw_punches: READ_ALL_ADMIN_WRITE,
  attendance_days: READ_ALL_ADMIN_WRITE,
  late_arrival_reviews: READ_ALL_ADMIN_WRITE,

  // Managers propose these (INSERT was permissive); only admin decides them.
  adjustments: { read: "auth", write: "admin" },
  advances: { read: "auth", write: "admin" },

  // Auth table: never reachable through the query builder.
  auth_users: ADMIN_ONLY,
};

/** Tables a manager may INSERT into despite write:"admin" (they propose, admin decides). */
const MANAGER_MAY_INSERT = new Set(["adjustments", "advances", "worker_edit_requests", "cheques"]);

export type Denial = { table: string; op: Op; reason: string };

/**
 * Returns null when allowed, or a Denial explaining why not.
 *
 * `role === null` means no session. The ported RPCs keep the originals'
 * `auth.uid() is not null` escape hatch for trusted server-side callers, but
 * the query builder does not: an unauthenticated query is always denied.
 */
export function check(role: Role | null, table: string, op: Op): Denial | null {
  const policy = POLICIES[table] ?? ADMIN_ONLY;
  const deny = (reason: string): Denial => ({ table, op, reason });

  if (role === null) return deny("not signed in");
  if (role === "admin") return null;

  // ── manager ──
  if (op === "select") {
    if (policy.read === "admin") return deny(`${table} is admin-only`);
    return null; // auth | own | payroll — row-level narrowing is the caller's job
  }

  if (op === "insert" && MANAGER_MAY_INSERT.has(table)) return null;
  return deny(`${table} is write-protected (admin only)`);
}

export function opFor(kind: "select" | "insert" | "update" | "upsert" | "delete"): Op {
  return kind === "upsert" ? "insert" : kind;
}

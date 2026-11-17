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

// Re-exported from the shared type rather than redeclared: a local copy silently
// drifted when ops_manager was added, and the compiler only caught it because a
// narrowed comparison went dead.
export type { Role } from "@/lib/types";
import type { Role } from "@/lib/types";

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
  upi_payer_accounts: ADMIN_ONLY,
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

  // Interview pipeline — readable by any signed-in staff; managers may also
  // add and decide (see MANAGER_MAY_INSERT / MANAGER_MAY_UPDATE).
  candidates: READ_ALL_ADMIN_WRITE,
  interview_rounds: READ_ALL_ADMIN_WRITE,

  // Auth table: never reachable through the query builder.
  auth_users: ADMIN_ONLY,
};

/** Tables a manager may INSERT into despite write:"admin" (they propose, admin decides). */
const MANAGER_MAY_INSERT = new Set([
  "adjustments", "advances", "worker_edit_requests", "cheques",
  "candidates", "interview_rounds",
]);

/**
 * Tables a manager may UPDATE. Unlike the propose/approve tables above, hiring
 * is not an approval workflow — whoever is running interviews shortlists and
 * rejects directly. Deliberately narrow: no other table is listed.
 */
const MANAGER_MAY_UPDATE = new Set(["candidates"]);

/**
 * ops_manager: capture cheques, hand them to the bank. Nothing else.
 *
 * An explicit allow-list rather than a subtraction from `manager`, so adding a
 * table elsewhere in the app cannot silently widen what this role can reach.
 * Everything not named here is denied.
 *
 *   cheques               — read the queue, insert new ones
 *   company_bank_accounts — read only, to populate the "present to" dropdown
 *   profiles              — read only, so the app can resolve their own role
 *   settings              — read only, warehouse timezone / display settings
 *
 * Note audit_log is absent: writes still record an audit entry, but those go
 * through the RPC layer with the connection's own privileges, not this map.
 */
const OPS_MANAGER_READ = new Set(["cheques", "company_bank_accounts", "profiles", "settings"]);
const OPS_MANAGER_INSERT = new Set(["cheques"]);

/**
 * ops_manager_hr: everything a manager does inside the HR System, nothing else.
 *
 * Enumerated rather than derived from `manager`, for the same reason
 * ops_manager is: falling through to the manager branch would hand this role
 * the cheque queue, the interview pipeline and the payroll reads that a
 * manager also has, none of which is HR. An allow-list cannot widen by
 * accident when a table is added somewhere else.
 *
 * The read set is exactly what the three HR screens they can reach touch:
 *
 *   Overview     — raw_punches, devices, attendance_days, adjustments,
 *                  workers, worker_edit_requests, profiles, settings
 *   Adjustments  — adjustments, workers
 *   Employees    — workers, worker_groups, worker_edit_requests
 *
 * worker_bank_details stays out: it is ADMIN_ONLY and a manager cannot read it
 * either, so neither can this role. Same for audit_log and device_users.
 */
const OPS_MANAGER_HR_READ = new Set([
  "workers", "worker_groups", "worker_edit_requests", "adjustments",
  "attendance_days", "raw_punches", "devices", "late_arrival_reviews",
  "work_calendar", "profiles", "settings",
]);

/** They propose; an admin still decides. Mirrors what a manager may insert. */
const OPS_MANAGER_HR_INSERT = new Set(["adjustments", "worker_edit_requests"]);

/**
 * Columns only an admin may READ, stripped from results for everyone else.
 *
 * The policy map above is table-level, as RLS was: it answers "may you read
 * this table at all", not "which columns". That gap leaked — a manager and an
 * HR ops manager could reach the Employees page, and the page did
 * `select("*")`, so pay landed in the rendered payload even where no column
 * displayed it.
 *
 * Fixed centrally rather than by auditing every select, for the same reason
 * the policy map exists: a rule applied in one place cannot be forgotten by
 * the next page someone writes. A query asking for a redacted column still
 * succeeds — the key is simply absent from the rows, exactly as though the
 * column did not exist for that caller.
 *
 * worker_bank_details is NOT here: that whole table is already ADMIN_ONLY.
 */
const ADMIN_ONLY_COLUMNS: Record<string, readonly string[]> = {
  workers: ["monthly_salary", "id_proof_path"],
};

/** Columns to strip from this role's results for `table`. Empty = nothing. */
export function redactedColumns(role: Role | null, table: string): readonly string[] {
  if (role === "admin") return [];
  return ADMIN_ONLY_COLUMNS[table] ?? [];
}

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

  // ── ops_manager: allow-list only ──
  if (role === "ops_manager") {
    if (op === "select") {
      return OPS_MANAGER_READ.has(table) ? null : deny(`${table} is not available to ops managers`);
    }
    if (op === "insert" && OPS_MANAGER_INSERT.has(table)) return null;
    return deny(`ops managers cannot modify ${table}`);
  }

  // ── ops_manager_hr: allow-list only ──
  if (role === "ops_manager_hr") {
    if (op === "select") {
      return OPS_MANAGER_HR_READ.has(table)
        ? null
        : deny(`${table} is outside the HR System`);
    }
    if (op === "insert" && OPS_MANAGER_HR_INSERT.has(table)) return null;
    return deny(`HR ops managers cannot modify ${table}`);
  }

  // ── manager ──
  if (op === "select") {
    if (policy.read === "admin") return deny(`${table} is admin-only`);
    return null; // auth | own | payroll — row-level narrowing is the caller's job
  }

  if (op === "insert" && MANAGER_MAY_INSERT.has(table)) return null;
  if (op === "update" && MANAGER_MAY_UPDATE.has(table)) return null;
  return deny(`${table} is write-protected (admin only)`);
}

export function opFor(kind: "select" | "insert" | "update" | "upsert" | "delete"): Op {
  return kind === "upsert" ? "insert" : kind;
}

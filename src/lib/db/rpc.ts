import type { PoolConnection } from "mysql2/promise";
import { transaction, query } from "./pool";
import type { Row } from "./builder";

/**
 * Ported Postgres RPCs.
 *
 * The originals were SECURITY DEFINER functions that enforced their own
 * permission checks with is_admin() / is_manager() and relied on RLS for
 * everything else. MySQL has neither, so each port carries its checks
 * explicitly — and they are the SAME checks, in the same order, so behaviour
 * (including which error a user sees) is unchanged.
 *
 * Two properties from the originals that are easy to lose and must not be:
 *   - Row locking. Each mutation re-reads its row FOR UPDATE inside a
 *     transaction before validating status. Without it two admins clicking
 *     "mark passed" concurrently could both pass the status check.
 *   - Audit writes. Every state change appends to audit_log in the SAME
 *     transaction, so an audit trail can't be missing for a change that stuck.
 *
 * Functions are ported incrementally. `isRpcImplemented` gates the rest so an
 * unported name fails loudly instead of silently doing nothing.
 */

type Ctx = { conn: PoolConnection; userId: string | null };

const IMPLEMENTED = new Set([
  // cheques
  "create_cheque",
  "submit_cheque",
  "update_cheque_draft",
  "record_cheque_presented",
  "mark_cheque_outcome",
  "admin_update_cheque",
  // attendance
  "recompute_attendance",
  "decide_adjustment",
  "decide_late_review",
  "admin_set_device_pin",
  "admin_auto_settle_cheque",
  "unlinked_punch_pins",
  // advances
  "decide_advance",
  "record_advance_disbursal",
  // payroll
  "record_disbursal",
  "compute_payroll_run",
  "approve_payroll_run",
  "reopen_payroll_run",
  // workers
  "request_new_worker",
  "approve_new_worker",
  "reject_new_worker",
  "request_worker_edit",
  "decide_worker_edit",
  "set_worker_media",
]);

export function isRpcImplemented(name: string): boolean {
  return IMPLEMENTED.has(name);
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function roleOf(conn: PoolConnection, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [rows] = await conn.query("SELECT role FROM profiles WHERE id = ? LIMIT 1", [userId]);
  return (rows as { role: string }[])[0]?.role ?? null;
}

/**
 * The originals guarded with `if auth.uid() is not null and not is_admin()`.
 * That "is not null" matters: it let trusted server-side callers with no session
 * through. Preserved exactly rather than tightened, so nothing that worked
 * before starts failing.
 */
async function requireAdmin(ctx: Ctx, fn: string): Promise<void> {
  if (ctx.userId === null) return;
  if ((await roleOf(ctx.conn, ctx.userId)) !== "admin") {
    throw new Error(`${fn}: admin only`);
  }
}

async function requireStaff(ctx: Ctx, fn: string): Promise<void> {
  if (ctx.userId === null) return;
  const r = await roleOf(ctx.conn, ctx.userId);
  if (r !== "admin" && r !== "manager") throw new Error(`${fn}: staff only`);
}

async function writeAudit(
  ctx: Ctx,
  action: string,
  table: string,
  entityId: string,
  before: unknown,
  after: unknown,
  reason: string | null
): Promise<void> {
  await ctx.conn.query(
    `INSERT INTO audit_log (actor_id, action, entity_table, entity_id, before_value, after_value, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      ctx.userId,
      action,
      table,
      entityId,
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
      reason,
    ]
  );
}

/**
 * Port of can_disburse_group(): may this manager pay this worker's group?
 *
 * Admins bypass. A manager qualifies via an explicit manager_group_access row,
 * or by holding full_access. Fails CLOSED when the line carries no group
 * snapshot — an unattributable payroll line is exactly the case not to guess on.
 */
async function canDisburseGroup(ctx: Ctx, groupId: string | null): Promise<boolean> {
  if (ctx.userId === null) return true; // trusted server-side caller
  if ((await roleOf(ctx.conn, ctx.userId)) === "admin") return true;
  if (!groupId) return false;

  const [rows] = await ctx.conn.query(
    `SELECT 1 FROM manager_group_access WHERE manager_id = ? AND group_id = ?
      UNION SELECT 1 FROM profiles WHERE id = ? AND full_access = 1
      LIMIT 1`,
    [ctx.userId, groupId, ctx.userId]
  );
  return (rows as unknown[]).length > 0;
}

async function lockCheque(ctx: Ctx, id: string): Promise<Row> {
  const [rows] = await ctx.conn.query("SELECT * FROM cheques WHERE id = ? FOR UPDATE", [id]);
  const c = (rows as Row[])[0];
  if (!c) throw new Error(`cheque ${id} not found`);
  return c;
}

/** Mirrors apply_cheque_fields(): only these columns are writable from a payload. */
const CHEQUE_FIELDS = [
  "cheque_number", "amount", "cheque_date", "received_date", "dealer_name",
  "bank_name", "branch", "ifsc", "account_number", "micr_code",
  "payee_name", "amount_in_words", "notes",
] as const;

async function applyChequeFields(ctx: Ctx, id: string, p: Row): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const f of CHEQUE_FIELDS) {
    if (!(f in p)) continue;
    const raw = p[f];
    // Empty strings become NULL, matching nullif(...,'') in the original.
    const v = typeof raw === "string" && raw.trim() === "" ? null : raw;
    sets.push(`\`${f}\` = ?`);
    params.push(f === "amount" && v != null ? String(v) : v);
  }
  if (!sets.length) return;
  params.push(id);
  await ctx.conn.query(`UPDATE cheques SET ${sets.join(", ")} WHERE id = ?`, params);
}

function uuid(): string {
  return crypto.randomUUID();
}

/** Trim to null — mirrors Postgres nullif(trim(x), ''). */
function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** DECIMAL comes back as a string (deliberately — see pool.ts). */
function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Postgres round(numeric, 2) — half-up, away from zero.
 * The EPSILON nudge stops binary floating point turning a value that is exactly
 * x.xx5 in decimal into a down-round. Payroll figures are money; a paisa drift
 * per line compounds across a run.
 */
function round2(n: number): number {
  return Math.sign(n) * Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100;
}

// ── settings + timezone helpers (setting_num / warehouse_tz) ────────────────

async function settingRaw(conn: PoolConnection, key: string): Promise<string | null> {
  const [rows] = await conn.query("SELECT value FROM settings WHERE `key` = ?", [key]);
  const v = (rows as { value: unknown }[])[0]?.value;
  if (v == null) return null;
  // settings.value is JSON; a scalar setting arrives as a JSON string or number.
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return parsed == null ? null : String(parsed);
    } catch {
      return v;
    }
  }
  return String(v);
}

async function settingNum(conn: PoolConnection, key: string): Promise<number> {
  const raw = await settingRaw(conn, key);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

async function warehouseTz(conn: PoolConnection): Promise<string> {
  return (await settingRaw(conn, "warehouse_timezone")) || "Asia/Kolkata";
}

/**
 * A UTC DATETIME string as it reads in the warehouse timezone.
 *
 * The engine repeatedly asks "which local day is this punch on?" and "was the
 * first punch after the late cutoff?". Postgres did that with
 * `AT TIME ZONE tz`; here Intl does the conversion. Getting this wrong would
 * silently shift punches near midnight into the wrong day.
 */
function zoned(utc: string | Date, tz: string): { date: string; time: string } {
  const d = utc instanceof Date ? utc : new Date(String(utc).replace(" ", "T") + "Z");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    date: `${g("year")}-${g("month")}-${g("day")}`,
    time: `${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}:${g("second")}`,
  };
}

const toUtcDate = (s: string): Date => new Date(String(s).replace(" ", "T") + "Z");
const toSqlDt = (d: Date): string => d.toISOString().slice(0, 23).replace("T", " ");

/** Port of dedupe_punch_times(): collapse finger-retries inside the window. */
async function dedupePunchTimes(
  conn: PoolConnection, workerId: string, day: string, windowMin: number, tz: string
): Promise<Date[]> {
  const [wrows] = await conn.query("SELECT device_user_id FROM workers WHERE id = ?", [workerId]);
  const pin = (wrows as { device_user_id: number | null }[])[0]?.device_user_id ?? null;

  // Includes unlinked punches from this worker's terminal PIN, as the original
  // did — the PIN is unique, so they can only be this person.
  const [rows] = await conn.query(
    `SELECT device_ts FROM raw_punches
      WHERE (worker_id = ? OR (worker_id IS NULL AND ? IS NOT NULL AND device_user_id = ?))
      ORDER BY device_ts`,
    [workerId, pin, pin]
  );

  const kept: Date[] = [];
  let last: Date | null = null;
  for (const r of rows as { device_ts: string }[]) {
    const ts = toUtcDate(r.device_ts);
    // Day filter is applied in warehouse-local terms, not UTC.
    if (zoned(ts, tz).date !== day) continue;
    if (last === null || ts.getTime() >= last.getTime() + windowMin * 60_000) {
      kept.push(ts);
      last = ts;
    }
  }
  return kept;
}

/**
 * Port of recompute_attendance(): the only writer of attendance_days.
 * Idempotent — safe to re-run for any range.
 */
async function recomputeAttendance(ctx: Ctx, fromDate: string, toDate: string): Promise<void> {
  const { conn } = ctx;
  const vFull = await settingNum(conn, "full_day_hours");
  const vBreak = await settingNum(conn, "break_deduction_minutes");
  const vWin = await settingNum(conn, "dedupe_window_minutes");
  const tz = await warehouseTz(conn);

  const cutoffRaw = await settingRaw(conn, "late_first_punch_cutoff");
  const cutoff = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(cutoffRaw ?? "")
    ? (cutoffRaw as string).length === 5 ? `${cutoffRaw}:00` : (cutoffRaw as string)
    : "22:00:00";

  for (let d = new Date(fromDate + "T00:00:00Z"); toSqlDt(d).slice(0, 10) <= toDate; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = toSqlDt(d).slice(0, 10);

    const [cal] = await conn.query("SELECT day_type FROM work_calendar WHERE day = ?", [day]);
    const calType = (cal as { day_type: string }[])[0]?.day_type ?? "working";

    const [ws] = await conn.query(
      `SELECT id FROM workers
        WHERE is_active = 1 AND joined_on <= ? AND (left_on IS NULL OR left_on >= ?)`,
      [day, day]
    );

    for (const w of ws as { id: string }[]) {
      let fromAdj = false;
      let first: Date | null = null;
      let last: Date | null = null;
      let hours: number | null = null;
      let status: string;

      if (calType === "closed") {
        status = "not_working_day";
      } else {
        const kept = await dedupePunchTimes(conn, w.id, day, vWin, tz);

        const [adjRows] = await conn.query(
          `SELECT * FROM adjustments
            WHERE worker_id = ? AND day = ? AND status = 'approved'
            ORDER BY decided_at IS NULL, decided_at DESC LIMIT 1`,
          [w.id, day]
        );
        const adj = (adjRows as Row[])[0];

        if (adj) {
          fromAdj = true;
          const set = [...kept];
          if (adj.proposed_in) set.push(toUtcDate(String(adj.proposed_in)));
          if (adj.proposed_out) set.push(toUtcDate(String(adj.proposed_out)));
          if (set.length) {
            first = new Date(Math.min(...set.map((t) => t.getTime())));
            last = new Date(Math.max(...set.map((t) => t.getTime())));
            hours = Math.max((last.getTime() - first.getTime()) / 3_600_000 - vBreak / 60, 0);
          }
          status = hours != null && hours >= vFull ? "full_day" : "absent";
        } else if (kept.length === 0) {
          status = "absent";
        } else {
          first = kept[0];
          last = kept[kept.length - 1];

          if (zoned(first, tz).time > cutoff) {
            const [lr] = await conn.query(
              "SELECT status FROM late_arrival_reviews WHERE worker_id = ? AND day = ?",
              [w.id, day]
            );
            const review = (lr as { status: string }[])[0]?.status;
            if (review === "approved") {
              hours = Math.max((last.getTime() - first.getTime()) / 3_600_000 - vBreak / 60, 0);
              status = "full_day";
            } else if (review === "rejected") {
              status = "absent";
            } else {
              status = "late_review";
            }
          } else if (kept.length === 1) {
            status = "unresolved"; // dangling punch, not late
          } else {
            hours = Math.max((last.getTime() - first.getTime()) / 3_600_000 - vBreak / 60, 0);
            status = hours >= vFull ? "full_day" : "absent";
          }
        }
      }

      await conn.query(
        `INSERT INTO attendance_days
           (id, worker_id, day, first_in, last_out, worked_hours, status, is_from_adjustment, computed_at)
         VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6))
         ON DUPLICATE KEY UPDATE
           first_in = VALUES(first_in), last_out = VALUES(last_out),
           worked_hours = VALUES(worked_hours), status = VALUES(status),
           is_from_adjustment = VALUES(is_from_adjustment), computed_at = VALUES(computed_at)`,
        [
          uuid(), w.id, day,
          first ? toSqlDt(first) : null,
          last ? toSqlDt(last) : null,
          hours == null ? null : hours.toFixed(2),
          status, fromAdj ? 1 : 0,
        ]
      );
    }
  }
}

function today(): string {
  // Warehouse timezone, matching current_date under Asia/Kolkata.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

// ── ported functions ────────────────────────────────────────────────────────

const REGISTRY: Record<string, (ctx: Ctx, args: Row) => Promise<unknown>> = {
  async create_cheque(ctx, args) {
    const p = (args.p ?? {}) as Row;
    await requireStaff(ctx, "create_cheque");
    const id = uuid();
    const src = (p.extraction_source as string)?.trim() || "manual";
    await ctx.conn.query(
      `INSERT INTO cheques (id, status, uploaded_by, extraction_source, extracted_raw)
       VALUES (?, 'draft', ?, ?, ?)`,
      [id, ctx.userId, src, p.extracted_raw == null ? null : JSON.stringify(p.extracted_raw)]
    );
    await applyChequeFields(ctx, id, p);
    await writeAudit(ctx, "cheque_created", "cheques", id, null, p, null);
    return id;
  },

  async update_cheque_draft(ctx, args) {
    const id = args.p_id as string;
    const p = (args.p ?? {}) as Row;
    const c = await lockCheque(ctx, id);
    if (ctx.userId !== null) {
      const r = await roleOf(ctx.conn, ctx.userId);
      if (r !== "admin" && c.uploaded_by !== ctx.userId) {
        throw new Error("you can only edit cheques you uploaded");
      }
    }
    if (c.status !== "draft" && c.status !== "rejected") {
      throw new Error(`cheque ${id} is not editable (status ${c.status})`);
    }
    await applyChequeFields(ctx, id, p);
    await writeAudit(ctx, "cheque_updated", "cheques", id, c, p, null);
    return null;
  },

  async submit_cheque(ctx, args) {
    const id = args.p_id as string;
    const c = await lockCheque(ctx, id);

    if (ctx.userId !== null) {
      const r = await roleOf(ctx.conn, ctx.userId);
      if (r !== "admin" && c.uploaded_by !== ctx.userId) {
        throw new Error("you can only submit cheques you uploaded");
      }
    }
    if (c.status !== "draft" && c.status !== "rejected") {
      throw new Error(`cheque ${id} is not editable (status ${c.status})`);
    }
    const num = String(c.cheque_number ?? "").trim();
    const amt = c.amount == null ? null : Number(c.amount);
    const dealer = String(c.dealer_name ?? "").trim();
    if (!num || amt == null || !(amt > 0) || !dealer) {
      throw new Error(
        "cheque number, a positive amount, and dealer name are required before submitting"
      );
    }
    await ctx.conn.query(
      "UPDATE cheques SET status = 'submitted', submitted_at = UTC_TIMESTAMP(6) WHERE id = ?",
      [id]
    );
    await writeAudit(ctx, "cheque_submitted", "cheques", id, c, null, null);
    return null;
  },

  async record_cheque_presented(ctx, args) {
    await requireAdmin(ctx, "record_cheque_presented");
    const id = args.p_id as string;
    const bank = (args.p_bank_account ?? null) as string | null;
    const date = (args.p_date as string) || today();

    const c = await lockCheque(ctx, id);
    if (c.status !== "submitted") {
      throw new Error(`only approved cheques can be presented (cheque ${id} is ${c.status})`);
    }
    await ctx.conn.query(
      `UPDATE cheques SET status = 'presented', our_bank_account_id = ?, presented_date = ?
       WHERE id = ?`,
      [bank, date, id]
    );
    await writeAudit(ctx, "cheque_presented", "cheques", id, null,
      { our_bank_account_id: bank, presented_date: date }, null);
    return null;
  },

  async mark_cheque_outcome(ctx, args) {
    await requireAdmin(ctx, "mark_cheque_outcome");
    const id = args.p_id as string;
    const passed = Boolean(args.p_passed);
    const date = (args.p_date as string) || today();
    const reason = (args.p_reason as string | null) ?? null;

    const c = await lockCheque(ctx, id);
    if (c.status !== "presented") {
      throw new Error(
        `only presented cheques can be marked passed or bounced (cheque ${id} is ${c.status})`
      );
    }
    if (!passed && !String(reason ?? "").trim()) {
      throw new Error("a bounce requires a reason");
    }
    await ctx.conn.query(
      `UPDATE cheques SET status = ?, cleared_date = ?, bounce_reason = ? WHERE id = ?`,
      [passed ? "passed" : "bounced", date, passed ? null : reason, id]
    );
    await writeAudit(ctx, passed ? "cheque_passed" : "cheque_bounced", "cheques", id, null,
      { date }, reason);
    return null;
  },

  async recompute_attendance(ctx, args) {
    await requireAdmin(ctx, "recompute_attendance");
    await recomputeAttendance(
      ctx,
      String(args.from_date ?? args.p_from ?? today()),
      String(args.to_date ?? args.p_to ?? today())
    );
    return null;
  },

  async decide_adjustment(ctx, args) {
    await requireAdmin(ctx, "decide_adjustment");
    const id = args.p_id as string;
    const approve = Boolean(args.p_approve);
    const reason = (args.p_reason as string | null) ?? null;

    const [rows] = await ctx.conn.query("SELECT * FROM adjustments WHERE id = ? FOR UPDATE", [id]);
    const adj = (rows as Row[])[0];
    if (!adj) throw new Error(`adjustment ${id} not found`);
    if (adj.status !== "pending") throw new Error(`adjustment ${id} already decided`);
    if (!approve && !String(reason ?? "").trim()) throw new Error("rejection requires a reason");

    // Blocked for any period belonging to a closed payroll run (spec §3.5).
    const [clash] = await ctx.conn.query(
      `SELECT 1 FROM payroll_runs WHERE status = 'closed' AND ? BETWEEN period_start AND period_end LIMIT 1`,
      [adj.day]
    );
    if ((clash as unknown[]).length) {
      throw new Error(`adjustment day ${adj.day} falls in a closed payroll run`);
    }

    await ctx.conn.query(
      `UPDATE adjustments SET status = ?, decided_by = ?, decided_at = UTC_TIMESTAMP(6), decision_reason = ?
        WHERE id = ?`,
      [approve ? "approved" : "rejected", ctx.userId, reason, id]
    );
    await writeAudit(ctx, approve ? "adjustment_approved" : "adjustment_rejected", "adjustments", id,
      { status: "pending" }, { status: approve ? "approved" : "rejected" }, reason);

    // Approval affects attendance immediately; rebuild just that day.
    if (approve) await recomputeAttendance(ctx, String(adj.day), String(adj.day));
    return null;
  },

  async decide_advance(ctx, args) {
    await requireAdmin(ctx, "decide_advance");
    const id = args.p_id as string;
    const approve = Boolean(args.p_approve);
    const reason = (args.p_reason as string | null) ?? null;

    const [rows] = await ctx.conn.query("SELECT * FROM advances WHERE id = ? FOR UPDATE", [id]);
    const adv = (rows as Row[])[0];
    if (!adv) throw new Error(`advance ${id} not found`);
    if (adv.status !== "pending") throw new Error(`advance ${id} already decided`);
    if (!approve && !String(reason ?? "").trim()) throw new Error("rejection requires a reason");

    await ctx.conn.query(
      `UPDATE advances SET status = ?, decided_by = ?, decided_at = UTC_TIMESTAMP(6), decision_reason = ?
        WHERE id = ?`,
      [approve ? "approved" : "rejected", ctx.userId, reason, id]
    );
    await writeAudit(ctx, approve ? "advance_approved" : "advance_rejected", "advances", id,
      { status: "pending" }, { status: approve ? "approved" : "rejected" }, reason);
    return null;
  },

  async decide_late_review(ctx, args) {
    await requireAdmin(ctx, "decide_late_review");
    const worker = args.p_worker as string;
    const day = String(args.p_day);
    const approve = Boolean(args.p_approve);
    const reason = (args.p_reason as string | null) ?? null;
    if (!approve && !String(reason ?? "").trim()) throw new Error("rejection requires a reason");

    await ctx.conn.query(
      `INSERT INTO late_arrival_reviews (worker_id, day, status, decided_by, decided_at, reason)
       VALUES (?,?,?,?,UTC_TIMESTAMP(6),?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), decided_by = VALUES(decided_by),
         decided_at = VALUES(decided_at), reason = VALUES(reason)`,
      [worker, day, approve ? "approved" : "rejected", ctx.userId, reason]
    );
    await writeAudit(ctx, approve ? "late_day_approved" : "late_day_rejected", "attendance_days",
      `${worker}:${day}`, null, { day, approved: approve }, reason);

    await recomputeAttendance(ctx, day, day);
    return null;
  },

  async admin_set_device_pin(ctx, args) {
    await requireAdmin(ctx, "admin_set_device_pin");
    const worker = args.p_worker as string;
    const pin = args.p_pin == null ? null : Number(args.p_pin);
    if (pin != null && pin <= 0) throw new Error("device PIN must be a positive number");

    if (pin != null) {
      const [dupe] = await ctx.conn.query(
        "SELECT 1 FROM workers WHERE device_user_id = ? AND id <> ? LIMIT 1",
        [pin, worker]
      );
      if ((dupe as unknown[]).length) {
        throw new Error(`PIN ${pin} is already assigned to another employee`);
      }
    }
    const [res] = await ctx.conn.query("UPDATE workers SET device_user_id = ? WHERE id = ?", [pin, worker]);
    if ((res as { affectedRows: number }).affectedRows === 0) {
      throw new Error(`worker ${worker} not found`);
    }
    await writeAudit(ctx, "worker_device_pin_set", "workers", worker, null, { device_user_id: pin }, null);
    return null;
  },

  async request_new_worker(ctx, args) {
    const p = (args.p ?? {}) as Row;
    if (ctx.userId !== null && (await roleOf(ctx.conn, ctx.userId)) !== "manager") {
      throw new Error("request_new_worker: managers only");
    }
    const id = uuid();
    const device = p.device_user_id ? Number(p.device_user_id) : null;
    const group = str(p.group_id);
    await ctx.conn.query(
      `INSERT INTO workers
         (id, full_name, device_user_id, monthly_salary, joined_on, phone, group_id,
          is_active, approval_status, created_by)
       VALUES (?,?,?,NULL,?,?,?,0,'pending',?)`,
      [id, String(p.full_name ?? "").trim(), device,
       str(p.joined_on) ?? today(), str(p.phone), group, ctx.userId]
    );
    await writeAudit(ctx, "worker_new_requested", "workers", id, null, p, null);
    return id;
  },

  async approve_new_worker(ctx, args) {
    await requireAdmin(ctx, "approve_new_worker");
    const worker = args.p_worker as string;
    const salary = args.p_salary == null ? null : Number(args.p_salary);
    const acct = str(args.p_bank_account);
    const ifsc = str(args.p_bank_ifsc);

    const [rows] = await ctx.conn.query("SELECT * FROM workers WHERE id = ? FOR UPDATE", [worker]);
    const w = (rows as Row[])[0];
    if (!w) throw new Error(`worker ${worker} not found`);
    if (w.approval_status !== "pending") throw new Error(`worker ${worker} is not pending`);
    if (salary == null || !(salary > 0)) {
      throw new Error("a monthly salary greater than 0 is required");
    }
    await ctx.conn.query(
      `UPDATE workers SET monthly_salary = ?, is_active = 1, approval_status = 'active', approved_by = ?
        WHERE id = ?`,
      [salary.toFixed(2), ctx.userId, worker]
    );
    if (acct || ifsc) {
      await ctx.conn.query(
        `INSERT INTO worker_bank_details (worker_id, bank_account, bank_ifsc)
         VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE bank_account = VALUES(bank_account),
           bank_ifsc = VALUES(bank_ifsc), updated_at = UTC_TIMESTAMP(6)`,
        [worker, acct, ifsc]
      );
    }
    await writeAudit(ctx, "worker_new_approved", "workers", worker, null, { salary }, null);
    return null;
  },

  async reject_new_worker(ctx, args) {
    await requireAdmin(ctx, "reject_new_worker");
    const worker = args.p_worker as string;
    const reason = (args.p_reason as string | null) ?? null;
    if (!String(reason ?? "").trim()) throw new Error("rejection requires a reason");

    await ctx.conn.query(
      `UPDATE workers SET approval_status = 'rejected', is_active = 0
        WHERE id = ? AND approval_status = 'pending'`,
      [worker]
    );
    await writeAudit(ctx, "worker_new_rejected", "workers", worker, null, null, reason);
    return null;
  },

  async request_worker_edit(ctx, args) {
    const worker = args.p_worker as string;
    const p = (args.p ?? {}) as Row;
    if (ctx.userId !== null && (await roleOf(ctx.conn, ctx.userId)) !== "manager") {
      throw new Error("request_worker_edit: managers only");
    }
    const [wr] = await ctx.conn.query("SELECT group_id FROM workers WHERE id = ?", [worker]);
    const group = (wr as Row[])[0]?.group_id as string | null;
    if (!(await canDisburseGroup(ctx, group))) {
      throw new Error("you can only edit workers in your own groups");
    }
    const id = uuid();
    await ctx.conn.query(
      "INSERT INTO worker_edit_requests (id, worker_id, payload, requested_by) VALUES (?,?,?,?)",
      [id, worker, JSON.stringify(p), ctx.userId]
    );
    await writeAudit(ctx, "worker_edit_requested", "workers", worker, null, p, null);
    return id;
  },

  async decide_worker_edit(ctx, args) {
    await requireAdmin(ctx, "decide_worker_edit");
    const id = args.p_id as string;
    const approve = Boolean(args.p_approve);
    const reason = (args.p_reason as string | null) ?? null;

    const [rows] = await ctx.conn.query(
      "SELECT * FROM worker_edit_requests WHERE id = ? FOR UPDATE", [id]
    );
    const req = (rows as Row[])[0];
    if (!req) throw new Error(`edit request ${id} not found`);
    if (req.status !== "pending") throw new Error(`edit request ${id} already decided`);
    if (!approve && !String(reason ?? "").trim()) throw new Error("rejection requires a reason");

    if (approve) {
      const p: Row = typeof req.payload === "string" ? JSON.parse(req.payload) : (req.payload as Row);
      // `has` vs `coalesce` matters: an absent key leaves the column alone,
      // whereas a present-but-empty key clears it. Mirrors the `p ? 'key'` tests.
      const sets: string[] = [];
      const vals: unknown[] = [];
      const put = (col: string, v: unknown) => { sets.push(`\`${col}\` = ?`); vals.push(v); };

      if (str(p.full_name)) put("full_name", str(p.full_name));
      if (str(p.employee_code)) put("employee_code", str(p.employee_code));
      if ("device_user_id" in p) put("device_user_id", p.device_user_id ? Number(p.device_user_id) : null);
      if ("phone" in p) put("phone", str(p.phone));
      if ("group_id" in p) put("group_id", str(p.group_id));
      if (str(p.joined_on)) put("joined_on", str(p.joined_on));
      if ("left_on" in p) put("left_on", str(p.left_on));
      if ("is_active" in p) put("is_active", p.is_active ? 1 : 0);

      if (sets.length) {
        vals.push(req.worker_id);
        await ctx.conn.query(`UPDATE workers SET ${sets.join(", ")} WHERE id = ?`, vals);
      }
    }

    await ctx.conn.query(
      `UPDATE worker_edit_requests
          SET status = ?, decided_by = ?, decided_at = UTC_TIMESTAMP(6), decision_reason = ?
        WHERE id = ?`,
      [approve ? "approved" : "rejected", ctx.userId, reason, id]
    );
    await writeAudit(ctx, approve ? "worker_edit_approved" : "worker_edit_rejected", "workers",
      String(req.worker_id), null, req.payload, reason);
    return null;
  },

  async set_worker_media(ctx, args) {
    const worker = args.p_worker as string;
    const [rows] = await ctx.conn.query("SELECT * FROM workers WHERE id = ?", [worker]);
    const w = (rows as Row[])[0];
    if (!w) throw new Error(`worker ${worker} not found`);

    if (ctx.userId !== null) {
      const role = await roleOf(ctx.conn, ctx.userId);
      if (role !== "admin" && !(role === "manager" && await canDisburseGroup(ctx, w.group_id as string | null))) {
        throw new Error("set_worker_media: not allowed for this worker");
      }
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    if ("p_photo_path" in args) { sets.push("photo_path = ?"); vals.push(str(args.p_photo_path)); }
    if ("p_id_proof_path" in args) { sets.push("id_proof_path = ?"); vals.push(str(args.p_id_proof_path)); }
    if (sets.length) {
      vals.push(worker);
      await ctx.conn.query(`UPDATE workers SET ${sets.join(", ")} WHERE id = ?`, vals);
    }
    await writeAudit(ctx, "worker_media_set", "workers", worker, null,
      { photo: args.p_photo_path, id_proof: args.p_id_proof_path }, null);
    return null;
  },

  async compute_payroll_run(ctx, args) {
    await requireAdmin(ctx, "compute_payroll_run");
    const runId = args.p_run_id as string;
    const { conn } = ctx;

    const [rr] = await conn.query("SELECT * FROM payroll_runs WHERE id = ?", [runId]);
    const run = (rr as Row[])[0];
    if (!run) throw new Error(`payroll run ${runId} not found`);
    if (run.status !== "draft") {
      throw new Error(`payroll run ${runId} is ${run.status} — only draft runs may be computed`);
    }

    const divisor = await settingNum(conn, "daily_rate_divisor");
    const free = await settingNum(conn, "free_leave_units");

    // Refuse to compute over a period that is not settled (spec §3.6).
    const [held] = await conn.query(
      `SELECT COUNT(*) AS n FROM attendance_days
        WHERE day BETWEEN ? AND ? AND status IN ('unresolved','late_review')`,
      [run.period_start, run.period_end]
    );
    const nHeld = Number((held as { n: number }[])[0]?.n ?? 0);
    if (nHeld > 0) {
      throw new Error(`cannot compute: ${nHeld} held attendance day(s) (unresolved or late-review) in period`);
    }
    const [pend] = await conn.query(
      `SELECT COUNT(*) AS n FROM adjustments WHERE day BETWEEN ? AND ? AND status = 'pending'`,
      [run.period_start, run.period_end]
    );
    const nPend = Number((pend as { n: number }[])[0]?.n ?? 0);
    if (nPend > 0) throw new Error(`cannot compute: ${nPend} pending adjustment(s) in period`);

    // Recompute is destructive by design — lines are derived, never edited.
    await conn.query("DELETE FROM payroll_lines WHERE run_id = ?", [runId]);

    const [ws] = await conn.query(
      `SELECT * FROM workers
        WHERE is_active = 1 AND joined_on <= ? AND (left_on IS NULL OR left_on >= ?)`,
      [run.period_end, run.period_start]
    );

    for (const w of ws as Row[]) {
      const salary = num(w.monthly_salary);
      const daily = round2(salary / (divisor || 30));

      // Leave counting excludes extra_working days from both absent and half
      // counts — the spec ambiguity resolved in 0003_functions.sql.
      const [cnt] = await conn.query(
        `SELECT
           SUM(ad.status = 'full_day' AND COALESCE(cal.day_type,'working') IN ('working','swapped_working')) AS full_days,
           SUM(ad.status = 'absent'   AND COALESCE(cal.day_type,'working') IN ('working','swapped_working')) AS absent_days,
           SUM(ad.status = 'full_day' AND COALESCE(cal.day_type,'working') = 'extra_working')                AS extra_days
         FROM attendance_days ad
         LEFT JOIN work_calendar cal ON cal.day = ad.day
        WHERE ad.worker_id = ? AND ad.day BETWEEN ? AND ?`,
        [w.id, run.period_start, run.period_end]
      );
      const c0 = (cnt as Row[])[0] ?? {};
      const fullDays = Number(c0.full_days ?? 0);
      const absentDays = Number(c0.absent_days ?? 0);
      const extraDays = Number(c0.extra_days ?? 0);

      const leaveUnits = absentDays;
      const deduction = leaveUnits <= free ? 0 : round2(leaveUnits * daily);
      const extraPay = round2(extraDays * daily);

      const [out] = await conn.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM advances
          WHERE worker_id = ? AND status = 'approved' AND disbursed_at IS NOT NULL
            AND recovered_in_run IS NULL`,
        [w.id]
      );
      const outstanding = num((out as Row[])[0]?.total);

      // Recover an advance only if it fits entirely in this month's pay.
      const available = salary + extraPay - deduction;
      const recovery = outstanding > 0 && outstanding <= available ? outstanding : 0;
      const net = salary + extraPay - deduction - recovery;

      const lineId = uuid();
      await conn.query(
        `INSERT INTO payroll_lines
           (id, run_id, worker_id, group_id_snapshot, salary_snapshot, daily_rate_snapshot,
            full_days, half_days, absent_days, extra_days, leave_units, net)
         VALUES (?,?,?,?,?,?,?,0,?,?,?,?)`,
        [lineId, runId, w.id, w.group_id, salary.toFixed(2), daily.toFixed(2),
         fullDays, absentDays, extraDays, leaveUnits.toFixed(2), net.toFixed(2)]
      );

      // net is the SUM of these components, so PF/ESI can be added later
      // without a schema change (spec §3.10).
      const comps: [string, string, string, number][] = [
        ["base_salary", "Base salary", "earning", salary],
      ];
      if (extraPay > 0) comps.push(["extra_days", "Extra days worked", "earning", extraPay]);
      if (deduction > 0) comps.push(["leave_deduction", "Leave deduction", "deduction", deduction]);
      if (recovery > 0) comps.push(["advance_recovery", "Advance recovery", "deduction", recovery]);

      for (const [code, label, type, amount] of comps) {
        await conn.query(
          `INSERT INTO payroll_line_components (id, line_id, code, label, type, amount)
           VALUES (?,?,?,?,?,?)`,
          [uuid(), lineId, code, label, type, amount.toFixed(2)]
        );
      }
    }

    await conn.query("UPDATE payroll_runs SET computed_at = UTC_TIMESTAMP(6) WHERE id = ?", [runId]);
    await writeAudit(ctx, "payroll_run_computed", "payroll_runs", runId, null,
      { period_start: run.period_start, period_end: run.period_end }, null);
    return null;
  },

  async approve_payroll_run(ctx, args) {
    await requireAdmin(ctx, "approve_payroll_run");
    const runId = args.p_run_id as string;
    const [rr] = await ctx.conn.query("SELECT * FROM payroll_runs WHERE id = ? FOR UPDATE", [runId]);
    const run = (rr as Row[])[0];
    if (!run) throw new Error(`payroll run ${runId} not found`);
    if (run.status !== "draft") {
      throw new Error(`payroll run ${runId} is ${run.status} — only draft runs can be approved`);
    }

    // Only advances that existed at compute time AND were actually recovered in
    // a line. Deferred advances stay outstanding for a later run.
    await ctx.conn.query(
      `UPDATE advances a
          SET a.recovered_in_run = ?
        WHERE a.status = 'approved' AND a.disbursed_at IS NOT NULL AND a.recovered_in_run IS NULL
          AND a.disbursed_at <= COALESCE(?, UTC_TIMESTAMP(6))
          AND EXISTS (
            SELECT 1 FROM payroll_lines l
              JOIN payroll_line_components c ON c.line_id = l.id
             WHERE l.run_id = ? AND l.worker_id = a.worker_id
               AND c.code = 'advance_recovery' AND c.amount > 0)`,
      [runId, run.computed_at, runId]
    );
    await ctx.conn.query(
      `UPDATE payroll_runs SET status = 'admin_approved', approved_by = ?, approved_at = UTC_TIMESTAMP(6)
        WHERE id = ?`,
      [ctx.userId, runId]
    );
    await writeAudit(ctx, "payroll_run_approved", "payroll_runs", runId,
      { status: "draft" }, { status: "admin_approved" }, null);
    return null;
  },

  async reopen_payroll_run(ctx, args) {
    await requireAdmin(ctx, "reopen_payroll_run");
    const runId = args.p_run_id as string;
    const reason = (args.p_reason as string | null) ?? null;
    if (!String(reason ?? "").trim()) throw new Error("reopening a run requires a reason");

    const [rr] = await ctx.conn.query("SELECT * FROM payroll_runs WHERE id = ? FOR UPDATE", [runId]);
    const run = (rr as Row[])[0];
    if (!run) throw new Error(`payroll run ${runId} not found`);
    if (run.status !== "admin_approved") {
      throw new Error(`only admin_approved runs can be reopened (current: ${run.status})`);
    }
    const [paid] = await ctx.conn.query(
      "SELECT 1 FROM payroll_lines WHERE run_id = ? AND paid_at IS NOT NULL LIMIT 1",
      [runId]
    );
    if ((paid as unknown[]).length) throw new Error("cannot reopen: some lines are already paid");

    await ctx.conn.query("UPDATE advances SET recovered_in_run = NULL WHERE recovered_in_run = ?", [runId]);
    await ctx.conn.query(
      "UPDATE payroll_runs SET status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = ?",
      [runId]
    );
    await writeAudit(ctx, "payroll_run_REOPENED", "payroll_runs", runId,
      { status: "admin_approved" }, { status: "draft" }, reason);
    return null;
  },

  async admin_auto_settle_cheque(ctx, args) {
    await requireAdmin(ctx, "admin_auto_settle_cheque");
    const id = args.p_id as string;
    const passed = Boolean(args.p_passed);
    const presented = (args.p_presented_date as string | null) ?? null;
    const outcome = (args.p_outcome_date as string | null) ?? null;
    const reason = (args.p_reason as string | null) ?? null;

    const c = await lockCheque(ctx, id);
    if (c.status !== "submitted" && c.status !== "presented") {
      throw new Error(`only an outstanding cheque can be auto-settled (cheque ${id} is ${c.status})`);
    }
    await ctx.conn.query(
      `UPDATE cheques SET status = ?,
         presented_date = COALESCE(presented_date, ?, ?),
         cleared_date = COALESCE(?, ?),
         bounce_reason = ?
        WHERE id = ?`,
      [
        passed ? "passed" : "bounced",
        presented, today(),
        outcome, today(),
        passed ? null : (String(reason ?? "").trim() || null),
        id,
      ]
    );
    await writeAudit(ctx, passed ? "cheque_auto_passed" : "cheque_auto_bounced", "cheques", id,
      null, { presented_date: presented, outcome_date: outcome, reason }, null);
    return null;
  },

  async record_advance_disbursal(ctx, args) {
    await requireStaff(ctx, "record_advance_disbursal");
    const id = args.p_id as string;
    const [rows] = await ctx.conn.query("SELECT * FROM advances WHERE id = ? FOR UPDATE", [id]);
    const adv = (rows as Row[])[0];
    if (!adv) throw new Error(`advance ${id} not found`);
    if (adv.status !== "approved") throw new Error(`advance ${id} is not approved`);
    if (adv.disbursed_at != null) throw new Error(`advance ${id} already disbursed`);

    await ctx.conn.query("UPDATE advances SET disbursed_at = UTC_TIMESTAMP(6) WHERE id = ?", [id]);
    await writeAudit(ctx, "advance_disbursed", "advances", id, null,
      { disbursed_at: new Date().toISOString() }, null);
    return null;
  },

  async record_disbursal(ctx, args) {
    await requireStaff(ctx, "record_disbursal");
    const lineId = args.p_line_id as string;
    const mode = (args.p_mode as string | null) ?? null;
    const reference = (args.p_reference as string | null) ?? null;
    if (!mode) throw new Error("a pay mode (cash or online) is required");

    const [lrows] = await ctx.conn.query("SELECT * FROM payroll_lines WHERE id = ? FOR UPDATE", [lineId]);
    const line = (lrows as Row[])[0];
    if (!line) throw new Error(`payroll line ${lineId} not found`);
    if (line.paid_at != null) throw new Error(`line ${lineId} is already paid`);

    if (ctx.userId !== null) {
      const role = await roleOf(ctx.conn, ctx.userId);
      if (role === "manager" && !(await canDisburseGroup(ctx, line.group_id_snapshot as string | null))) {
        throw new Error("you are not allowed to disburse this worker's group");
      }
    }

    const [rrows] = await ctx.conn.query("SELECT * FROM payroll_runs WHERE id = ? FOR UPDATE", [line.run_id]);
    const run = (rrows as Row[])[0];
    if (!run || (run.status !== "admin_approved" && run.status !== "disbursing")) {
      throw new Error(`run is ${run?.status} — disbursal not allowed`);
    }

    await ctx.conn.query(
      `UPDATE payroll_lines SET pay_mode = ?, paid_at = UTC_TIMESTAMP(6), paid_by = ?, payment_reference = ?
        WHERE id = ?`,
      [mode, ctx.userId, reference, lineId]
    );
    if (run.status === "admin_approved") {
      await ctx.conn.query("UPDATE payroll_runs SET status = 'disbursing' WHERE id = ?", [run.id]);
    }
    const [unpaid] = await ctx.conn.query(
      "SELECT COUNT(*) AS n FROM payroll_lines WHERE run_id = ? AND paid_at IS NULL",
      [run.id]
    );
    if (Number((unpaid as { n: number }[])[0]?.n ?? 0) === 0) {
      await ctx.conn.query(
        "UPDATE payroll_runs SET status = 'closed', closed_at = UTC_TIMESTAMP(6) WHERE id = ?",
        [run.id]
      );
    }
    await writeAudit(ctx, "payroll_line_paid", "payroll_lines", lineId, null,
      { pay_mode: mode, reference }, null);
    return null;
  },

  async unlinked_punch_pins(ctx) {
    await requireAdmin(ctx, "unlinked_punch_pins");
    const [rows] = await ctx.conn.query(
      `SELECT device_user_id AS pin, COUNT(*) AS punches,
              MIN(device_ts) AS first_seen, MAX(device_ts) AS last_seen
         FROM raw_punches
        WHERE worker_id IS NULL
        GROUP BY device_user_id
        ORDER BY MAX(device_ts) DESC`
    );
    return rows;
  },

  async admin_update_cheque(ctx, args) {
    await requireAdmin(ctx, "admin_update_cheque");
    const id = args.p_id as string;
    const p = (args.p ?? {}) as Row;
    const c = await lockCheque(ctx, id);
    await applyChequeFields(ctx, id, p);
    await writeAudit(ctx, "cheque_admin_edited", "cheques", id, c, p,
      (args.p_reason as string | null) ?? null);
    return null;
  },
};

export async function callRpc(name: string, args: Row, userId: string | null): Promise<unknown> {
  const fn = REGISTRY[name];
  if (!fn) throw new Error(`RPC "${name}" has not been ported to MySQL yet.`);
  return transaction((conn) => fn({ conn, userId }, args));
}

export { query };

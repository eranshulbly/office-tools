import mysql from "mysql2/promise";

/**
 * Single MySQL pool for the whole app.
 *
 * Connection budget matters here: the RDS instance is a db.t4g.micro, which
 * allows roughly 85 connections TOTAL across every app sharing it. Next.js
 * holds a pool per server process, so this is deliberately small — a runaway
 * pool here would starve the other apps on the same instance, not just this one.
 */
declare global {
  // eslint-disable-next-line no-var
  var __mysqlPool: mysql.Pool | undefined;
}

function create(): mysql.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  return mysql.createPool({
    uri: url,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE ?? 8),
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    // DECIMAL is returned as a JS number — see the typeCast note below.
    decimalNumbers: true,
    timezone: "Z",

    /**
     * Return DATETIME/TIMESTAMP as ISO-8601 UTC strings ("…T…Z").
     *
     * MySQL hands these back as "2026-08-13 11:51:46.790656" with no zone
     * marker. `new Date()` parses that shape as LOCAL time — so on this
     * IST server every stored UTC timestamp read 5h30m early, and any
     * "how long ago" calculation was wrong by the same amount. That is what
     * made a device seen seconds ago look hours stale.
     *
     * Postgres returned timestamptz WITH an offset, so the app was written
     * assuming `new Date(value)` is correct. Marking the string as UTC here
     * restores that assumption for every caller at once, rather than asking
     * ~50 call sites to remember.
     *
     * DATE columns are deliberately untouched: cheque_date, day and joined_on
     * are calendar dates, not instants, and code compares them as plain
     * "YYYY-MM-DD" strings.
     */
    typeCast(field, next) {
      if (field.type === "DATETIME" || field.type === "TIMESTAMP") {
        const v = field.string();
        return v == null ? null : `${v.replace(" ", "T")}Z`;
      }
      if (field.type === "DATE" || field.type === "NEWDATE") return field.string();

      /**
       * DECIMAL as a JS number.
       *
       * Postgres `numeric` arrived as a number, and the app is written that way
       * throughout — `amount.toFixed(2)`, arithmetic on cheque totals, chart
       * maths. Returning strings to "protect precision" instead broke those
       * silently at runtime, which is how the ledger reconciler started
       * throwing `toFixed is not a function`.
       *
       * Precision is not actually at risk here: money is stored DECIMAL(12,2),
       * so the largest representable value is ~10^10 rupees = 10^12 paise,
       * far inside float64's exact-integer range (2^53 ≈ 9×10^15). Totals are
       * summed by MySQL in exact DECIMAL, and the payroll engine rounds
       * explicitly at every step, so no accumulation error creeps in.
       */
      if (field.type === "DECIMAL" || field.type === "NEWDECIMAL") {
        const v = field.string();
        return v == null ? null : Number(v);
      }
      return next();
    },
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}

// Reused across hot reloads in dev so we don't leak pools on every edit.
export const pool: mysql.Pool = global.__mysqlPool ?? create();
if (process.env.NODE_ENV !== "production") global.__mysqlPool = pool;

/**
 * Force STRICT mode on every connection.
 *
 * RDS ships MySQL with sql_mode = NO_ENGINE_SUBSTITUTION only — STRICT is OFF.
 * Without it MySQL does not reject bad values, it quietly rewrites them:
 *
 *   an out-of-range DECIMAL(10,2) is CLAMPED to the maximum
 *   an invalid ENUM becomes '' (the empty string)
 *   an over-long VARCHAR is TRUNCATED
 *
 * On a payroll and cheque database those are silent corruptions of money and
 * status, which is far worse than a failed query. Postgres always behaved
 * strictly, so the app was written assuming a bad write raises.
 *
 * Set per-connection rather than via an RDS parameter group so it travels with
 * the code and cannot be lost when infrastructure is rebuilt. Worth ALSO
 * setting on the parameter group, so other apps on this instance are covered.
 */
pool.on("connection", (conn) => {
  conn.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',STRICT_TRANS_TABLES')");
});

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const [rows] = await pool.query(sql, params as unknown[]);
  return rows as T[];
}

export async function execute(
  sql: string,
  params: unknown[] = []
): Promise<{ affectedRows: number; insertId: number }> {
  const [res] = await pool.query(sql, params as unknown[]);
  const r = res as mysql.ResultSetHeader;
  return { affectedRows: r.affectedRows, insertId: r.insertId };
}

/** Run several statements atomically — used by the ported RPCs. */
export async function transaction<T>(
  fn: (conn: mysql.PoolConnection) => Promise<T>
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

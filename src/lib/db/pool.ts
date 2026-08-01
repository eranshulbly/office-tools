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
    // DECIMAL as string, not JS number — cheque amounts and payroll figures are
    // money. Letting them through as doubles would silently round at scale.
    decimalNumbers: false,
    // DATETIME columns hold UTC (the app's contract). Returning raw strings
    // stops mysql2 reinterpreting them in the server's local zone.
    dateStrings: true,
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}

// Reused across hot reloads in dev so we don't leak pools on every edit.
export const pool: mysql.Pool = global.__mysqlPool ?? create();
if (process.env.NODE_ENV !== "production") global.__mysqlPool = pool;

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

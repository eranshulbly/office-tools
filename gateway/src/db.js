import mysql from "mysql2/promise";
import { config } from "./config.js";

/**
 * The gateway's only channel to the database. Replaces supabase.js — the app
 * moved off Supabase to MySQL on RDS, so the service-role client is gone.
 *
 * Runs as a trusted system process: there is no user session here, so nothing
 * to authorise against. Access is limited by the MySQL user's own grants.
 */
const pool = mysql.createPool({
  uri: config.databaseUrl,
  waitForConnections: true,
  // Small on purpose. The RDS instance allows ~85 connections across every app
  // sharing it; a gateway that idles most of the day needs almost none.
  connectionLimit: 3,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  dateStrings: true,
  timezone: "Z",
});

// STRICT mode is off by default on RDS, which makes MySQL silently truncate and
// clamp bad values instead of rejecting them. Punches are attendance records —
// a quietly mangled timestamp is worse than a failed insert.
pool.on("connection", (conn) => {
  conn.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',STRICT_TRANS_TABLES')");
});

// device_user_id -> worker_id, refreshed periodically so newly-added workers
// resolve without a restart.
let workerMap = new Map();
let allowedSerials = new Set(config.allowedSerials);

export async function refreshWorkerMap() {
  try {
    const [rows] = await pool.query(
      "SELECT id, device_user_id FROM workers WHERE device_user_id IS NOT NULL"
    );
    const m = new Map();
    for (const w of rows) m.set(Number(w.device_user_id), w.id);
    workerMap = m;
  } catch (e) {
    console.error("[db] worker refresh failed:", e.message);
  }
}

export async function refreshAllowedSerials() {
  if (config.allowedSerials.length > 0) {
    allowedSerials = new Set(config.allowedSerials);
    return;
  }
  try {
    const [rows] = await pool.query("SELECT serial_number FROM devices");
    allowedSerials = new Set(rows.map((d) => d.serial_number));
  } catch (e) {
    console.error("[db] device refresh failed:", e.message);
  }
}

export function resolveWorker(deviceUserId) {
  return workerMap.get(Number(deviceUserId)) ?? null;
}

export function isKnownSerial(serial) {
  return allowedSerials.has(serial);
}

/** Register a device on first contact (setup convenience). */
export async function ensureDevice(serial) {
  if (allowedSerials.has(serial)) return;
  try {
    await pool.query(
      `INSERT INTO devices (serial_number, label) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE serial_number = serial_number`,
      [serial, `Auto-registered ${serial}`]
    );
    allowedSerials.add(serial);
    console.log(`[db] auto-registered new device ${serial}`);
  } catch (e) {
    console.error(`[db] auto-register ${serial} failed:`, e.message);
  }
}

/** Heartbeat + clock-drift inputs for the admin dashboard (spec §9). */
export async function touchDevice(serial, lastDeviceTs) {
  try {
    if (lastDeviceTs) {
      await pool.query(
        "UPDATE devices SET last_seen_at = UTC_TIMESTAMP(6), last_device_time = ? WHERE serial_number = ?",
        [toSqlDateTime(lastDeviceTs), serial]
      );
    } else {
      await pool.query(
        "UPDATE devices SET last_seen_at = UTC_TIMESTAMP(6) WHERE serial_number = ?",
        [serial]
      );
    }
  } catch (e) {
    console.error(`[db] touch ${serial} failed:`, e.message);
  }
}

/**
 * ISO instant -> the UTC 'YYYY-MM-DD HH:MM:SS.ffffff' a DATETIME(6) column
 * expects. The columns hold UTC by contract; sending an offset string would be
 * parsed inconsistently.
 */
function toSqlDateTime(v) {
  const d = v instanceof Date ? v : new Date(v);
  return d.toISOString().slice(0, 23).replace("T", " ");
}

/**
 * Insert punches idempotently.
 *
 * INSERT IGNORE relies on raw_punches_dedupe_uidx
 * (device_serial, device_user_id, device_ts) — the same unique index the
 * Postgres version used for ON CONFLICT DO NOTHING. Re-sending a batch after a
 * crash is therefore harmless, which is the whole point of store-and-forward.
 */
export async function insertPunches(rows) {
  if (!rows.length) return;
  const values = rows.map((r) => [
    r.device_serial,
    r.device_user_id,
    r.worker_id ?? null,
    toSqlDateTime(r.device_ts),
    r.verify_mode ?? null,
    r.raw_line,
  ]);
  await pool.query(
    `INSERT IGNORE INTO raw_punches
       (device_serial, device_user_id, worker_id, device_ts, verify_mode, raw_line)
     VALUES ?`,
    [values]
  );
}

/**
 * Forget what we think a terminal holds, so the next QUERY response rebuilds it.
 *
 * device_users is a MIRROR of the device, and upserts alone never remove a user
 * deleted on the terminal — the row simply lingers. That is not cosmetic: after
 * a PIN was deleted on the device, the app kept reporting it for another sync
 * cycle, which made a successful delete look like a failed one.
 *
 * Cleared when a DATA QUERY USERINFO is issued rather than while its replies
 * arrive: the device answers in several pushes, so pruning mid-sync would drop
 * users whose chunk simply hadn't landed yet.
 */
export async function clearDeviceUsers(serial) {
  try {
    await pool.query("DELETE FROM device_users WHERE device_serial = ?", [serial]);
  } catch (e) {
    console.error(`[db] clear device_users ${serial} failed:`, e.message);
  }
}

/**
 * Store the terminal's enrolled-user list (User ID + name) so an admin can map
 * PIN -> employee by name. Fingerprint templates are never passed in here.
 */
export async function upsertDeviceUsers(serial, users) {
  if (!users.length) return;
  const values = users.map((u) => [serial, u.pin, u.name || null]);
  await pool.query(
    `INSERT INTO device_users (device_serial, pin, name, updated_at)
     VALUES ${values.map(() => "(?,?,?,UTC_TIMESTAMP(6))").join(",")}
     ON DUPLICATE KEY UPDATE name = VALUES(name), updated_at = VALUES(updated_at)`,
    values.flat()
  );
}

/**
 * Ask the app to rebuild attendance for the affected days.
 *
 * recompute_attendance is no longer a database function — it was ported to
 * TypeScript in the Next.js app, which this separate Node process cannot call
 * directly. So the gateway pokes an internal HTTP endpoint on localhost instead.
 *
 * Failure is logged, never thrown: a punch that is safely stored must not be
 * rolled back because the derived attendance grid lagged. An admin can always
 * press "Recompute attendance".
 */
export async function recomputeDays(days) {
  if (!config.recomputeUrl || !config.recomputeSecret) return;
  for (const day of days) {
    try {
      const res = await fetch(config.recomputeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-gateway-secret": config.recomputeSecret,
        },
        body: JSON.stringify({ from: day, to: day }),
      });
      if (!res.ok) console.error(`[db] recompute ${day} -> HTTP ${res.status}`);
    } catch (e) {
      console.error(`[db] recompute ${day} failed:`, e.message);
    }
  }
}

/** Replace the fingerprint METADATA we hold for a terminal. No templates. */
export async function clearFingerprints(serial) {
  try {
    await pool.query("DELETE FROM device_fingerprints WHERE device_serial = ?", [serial]);
  } catch (e) {
    console.error(`[db] clear device_fingerprints ${serial} failed:`, e.message);
  }
}

export async function upsertFingerprints(serial, fps) {
  if (!fps.length) return;
  const values = fps.map((f) => [serial, f.pin, f.fid, f.valid ? 1 : 0]);
  await pool.query(
    `INSERT INTO device_fingerprints (device_serial, pin, fid, valid, updated_at)
     VALUES ${values.map(() => "(?,?,?,?,UTC_TIMESTAMP(6))").join(",")}
     ON DUPLICATE KEY UPDATE valid = VALUES(valid), updated_at = VALUES(updated_at)`,
    values.flat()
  );
}

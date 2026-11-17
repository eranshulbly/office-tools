import { config } from "./config.js";
import {
  resolveWorker,
  insertPunches,
  touchDevice,
  recomputeDays,
} from "./db.js";

/** YYYY-MM-DD for an instant, in the warehouse timezone (drives recompute). */
function warehouseDay(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.warehouseTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Forward one buffered batch: insert punches, heartbeat the device, recompute. */
async function forwardBatch(serial, records) {
  const rows = records.map((r) => ({
    device_serial: serial,
    device_user_id: r.device_user_id,
    worker_id: resolveWorker(r.device_user_id), // null if unknown (spec)
    device_ts: r.device_ts,
    server_ts: r.server_ts,
    verify_mode: r.verify_mode,
    raw_line: r.raw_line,
  }));

  await insertPunches(rows);

  const latest = rows.reduce((max, r) => (r.device_ts > max ? r.device_ts : max), rows[0].device_ts);
  await touchDevice(serial, latest);

  const days = Array.from(new Set(rows.map((r) => warehouseDay(r.device_ts))));
  await recomputeDays(days);
}

/**
 * Background drainer with exponential backoff. Keeps sending buffered batches
 * until the spool is empty; on any failure it backs off and retries — never
 * dropping a punch.
 */
export function startDrainer(spool) {
  let backoff = 0;

  function schedule(ms) {
    setTimeout(tick, ms);
  }

  async function tick() {
    const files = spool.pending();
    if (files.length === 0) {
      backoff = 0;
      return schedule(config.drainIntervalMs);
    }
    try {
      for (const file of files) {
        const { serial, records } = spool.read(file);
        await forwardBatch(serial, records);
        spool.ack(file);
      }
      backoff = 0;
      console.log(`[drain] forwarded ${files.length} batch(es); spool empty`);
      schedule(config.drainIntervalMs);
    } catch (err) {
      backoff = Math.min(backoff ? backoff * 2 : 2000, 60000);
      console.error(`[drain] forward failed — ${spool.depth()} batch(es) buffered, retry in ${backoff}ms: ${err.message}`);
      schedule(backoff);
    }
  }

  schedule(config.drainIntervalMs);
}

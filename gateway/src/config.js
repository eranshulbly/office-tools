import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, "..", ".env") });

function required(key) {
  const v = process.env[key];
  if (!v) {
    console.error(`[config] missing required env ${key} — set it in gateway/.env`);
    process.exit(1);
  }
  return v;
}

export const config = {
  port: Number(process.env.GATEWAY_PORT || 8080),

  supabaseUrl: required("SUPABASE_URL"),
  serviceKey: required("SUPABASE_SERVICE_ROLE_KEY"),

  // The K40 Pro sends naive local timestamps ("2026-07-13 08:47:31"). We attach
  // this offset to turn them into unambiguous instants. The device clock MUST be
  // set to this timezone (India = +05:30).
  deviceOffset: process.env.DEVICE_TZ_OFFSET || "+05:30",

  // Warehouse calendar-day timezone — must match the app's warehouse_timezone
  // setting so the recompute triggered here buckets punches into the right day.
  warehouseTz: process.env.WAREHOUSE_TZ || "Asia/Kolkata",

  // Comma-separated device serials to accept. If empty, serials are learned from
  // the devices table in Supabase (+ auto-registered on first contact when
  // AUTO_REGISTER_DEVICES is true).
  allowedSerials: (process.env.ALLOWED_SERIALS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // During initial setup, accept an unknown terminal on first contact and add it
  // to the devices table (its serial is logged). Turn OFF once devices are known.
  autoRegister: (process.env.AUTO_REGISTER_DEVICES ?? "true").toLowerCase() !== "false",

  // How often the background drainer flushes buffered punches to Supabase.
  drainIntervalMs: Number(process.env.DRAIN_INTERVAL_MS || 5000),

  spoolDir: join(__dirname, "..", "spool"),
};

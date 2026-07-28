import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

// Service-role client — bypasses RLS (trusted system context). This is the
// gateway's only channel to the cloud. It runs on the office PC, never exposed.
export const supabase = createClient(config.supabaseUrl, config.serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// device_user_id -> worker_id, refreshed periodically so newly-added workers
// resolve without a restart.
let workerMap = new Map();
let allowedSerials = new Set(config.allowedSerials);

export async function refreshWorkerMap() {
  const { data, error } = await supabase.from("workers").select("id, device_user_id");
  if (error) {
    console.error("[supabase] worker refresh failed:", error.message);
    return;
  }
  const m = new Map();
  for (const w of data ?? []) m.set(Number(w.device_user_id), w.id);
  workerMap = m;
}


export async function refreshAllowedSerials() {
  if (config.allowedSerials.length > 0) {
    allowedSerials = new Set(config.allowedSerials);
    return;
  }
  const { data, error } = await supabase.from("devices").select("serial_number");
  if (error) {
    console.error("[supabase] device refresh failed:", error.message);
    return;
  }
  allowedSerials = new Set((data ?? []).map((d) => d.serial_number));
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
  const { error } = await supabase
    .from("devices")
    .upsert({ serial_number: serial, label: `Auto-registered ${serial}` }, { onConflict: "serial_number" });
  if (error) {
    console.error(`[supabase] auto-register ${serial} failed:`, error.message);
    return;
  }
  allowedSerials.add(serial);
  console.log(`[supabase] auto-registered new device ${serial}`);
}

/** Heartbeat + clock-drift inputs for the admin dashboard (spec §9). */
export async function touchDevice(serial, lastDeviceTs) {
  const patch = { last_seen_at: new Date().toISOString() };
  if (lastDeviceTs) patch.last_device_time = lastDeviceTs;
  await supabase.from("devices").update(patch).eq("serial_number", serial);
}

/**
 * Insert punches idempotently. The unique index (device_serial, device_user_id,
 * device_ts) + ignoreDuplicates makes re-sends after a crash harmless.
 */
export async function insertPunches(rows) {
  const { error } = await supabase
    .from("raw_punches")
    .upsert(rows, { onConflict: "device_serial,device_user_id,device_ts", ignoreDuplicates: true });
  if (error) throw new Error(`insert raw_punches: ${error.message}`);
}

/**
 * Store the terminal's enrolled-user list (User ID + name) so an admin can map
 * PIN -> employee by name. Fingerprint templates are never passed in here.
 */
export async function upsertDeviceUsers(serial, users) {
  if (!users.length) return;
  const rows = users.map((u) => ({
    device_serial: serial,
    pin: u.pin,
    name: u.name || null,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase
    .from("device_users")
    .upsert(rows, { onConflict: "device_serial,pin" });
  if (error) throw new Error(`upsert device_users: ${error.message}`);
}

/** Rebuild attendance for the affected days so the grid updates live. */
export async function recomputeDays(days) {
  for (const day of days) {
    const { error } = await supabase.rpc("recompute_attendance", { from_date: day, to_date: day });
    if (error) throw new Error(`recompute ${day}: ${error.message}`);
  }
}

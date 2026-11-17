import { query } from "@/lib/db/pool";

/**
 * Push employee records to the ZKTeco terminals.
 *
 * The gateway holds a command queue that each device drains on its ~10s poll
 * (`/iclock/getrequest`). This asks the gateway to enqueue a
 * `DATA UPDATE USERINFO`, which creates or updates the user on the terminal.
 *
 * WHAT THIS DOES NOT DO: fingerprints. Pushing a user puts the PIN and name on
 * the device so the screen shows a person rather than a number, but each
 * employee must still physically enrol their finger. There is no way around
 * that without already holding the fingerprint templates.
 *
 * Every function here is best-effort and never throws into the caller: a
 * terminal being unplugged must not stop an employee being created in the app.
 * Failures are logged, and `syncAllWorkersToDevices` can always be re-run.
 */

const GATEWAY_URL = process.env.GATEWAY_ADMIN_URL || "http://127.0.0.1:8080";

/**
 * Verified against the live K40 Pro: a 50-character name round-trips intact
 * (measured, not assumed — the classic ZKTeco limit is 24, and an earlier
 * conservative guess of 36 would have chopped real job titles). Names are still
 * capped, because a silently truncated name on an attendance device is worse
 * than a visibly shortened one.
 */
const NAME_MAX = 50;

/**
 * "Ramesh Kumar" + "Driver" -> "Ramesh Kumar - Driver".
 *
 * When the pair is too long the DESIGNATION is trimmed first and the name kept
 * whole — you need to know who punched; the job title is context.
 */
export function deviceDisplayName(fullName: string, designation?: string | null): string {
  const name = (fullName ?? "").trim();
  const role = (designation ?? "").trim();
  if (!role) return name.slice(0, NAME_MAX);

  const sep = " - ";
  const room = NAME_MAX - name.length - sep.length;
  if (room < 3) return name.slice(0, NAME_MAX); // no useful space left for a title
  return `${name}${sep}${role.slice(0, room)}`;
}

async function queueCommand(serial: string, cmd: string): Promise<boolean> {
  try {
    const url = new URL("/admin/cmd", GATEWAY_URL);
    url.searchParams.set("sn", serial);
    url.searchParams.set("cmd", cmd);
    const res = await fetch(url, { method: "POST" });
    return res.ok;
  } catch (e) {
    console.error(`[device] queue to ${serial} failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}

async function activeSerials(): Promise<string[]> {
  const rows = await query<{ serial_number: string }>(
    "SELECT serial_number FROM devices WHERE is_active = 1"
  );
  return rows.map((r) => r.serial_number);
}

/**
 * Create or update one employee on every active terminal.
 *
 * Tab-separated fields are what the ADMS protocol expects; Pri=0 is a normal
 * user (not an admin), and the all-zero TZ means "no time-zone restriction".
 */
export async function pushWorkerToDevices(worker: {
  device_user_id: number | null;
  full_name: string;
  designation?: string | null;
}): Promise<{ pushed: number; serials: string[] }> {
  // No PIN means nothing to key the device record on.
  if (worker.device_user_id == null) return { pushed: 0, serials: [] };

  const name = deviceDisplayName(worker.full_name, worker.designation);
  const cmd =
    `DATA UPDATE USERINFO PIN=${worker.device_user_id}\tName=${name}` +
    `\tPri=0\tPasswd=\tCard=\tGrp=1\tTZ=0000000000000000`;

  const serials = await activeSerials();
  const done: string[] = [];
  for (const sn of serials) if (await queueCommand(sn, cmd)) done.push(sn);
  return { pushed: done.length, serials: done };
}

/** Remove an employee from the terminals (e.g. when they leave). */
export async function removeWorkerFromDevices(devicePin: number): Promise<void> {
  const cmd = `DATA DELETE USERINFO PIN=${devicePin}`;
  for (const sn of await activeSerials()) await queueCommand(sn, cmd);
}

/**
 * Push every active employee who has a PIN. Used after a bulk import, and as a
 * repair when a terminal has been offline or replaced.
 */
export async function syncAllWorkersToDevices(): Promise<{ workers: number; queued: number }> {
  const rows = await query<{
    device_user_id: number | null;
    full_name: string;
    designation: string | null;
  }>(
    `SELECT device_user_id, full_name, designation
       FROM workers
      WHERE is_active = 1 AND device_user_id IS NOT NULL`
  );
  let queued = 0;
  for (const w of rows) {
    const r = await pushWorkerToDevices(w);
    if (r.pushed > 0) queued += 1;
  }
  return { workers: rows.length, queued };
}

/** Ask each terminal to report its enrolled users, so the app can reconcile. */
export async function requestDeviceUserList(): Promise<void> {
  for (const sn of await activeSerials()) await queueCommand(sn, "DATA QUERY USERINFO");
}

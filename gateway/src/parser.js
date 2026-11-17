/**
 * ATTLOG parsing. The gateway is a pipe — it does NO business logic. It only
 * turns the device's tab-separated lines into structured records and attaches
 * the timezone offset so the timestamp is unambiguous. All rules live server-side.
 *
 * One record per line (spec §2.1):
 *   device_user_id \t timestamp \t status \t verify_mode \t workcode
 *   1042 \t 2026-07-13 08:47:31 \t 0 \t 1 \t 0
 */
export function parseAttlog(body, deviceOffset) {
  const lines = body.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "");
  const records = [];
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 2) continue; // not a valid ATTLOG row
    const pin = parseInt(parts[0], 10);
    const rawTs = (parts[1] || "").trim(); // "2026-07-13 08:47:31"
    if (!Number.isFinite(pin) || !rawTs) continue;

    // "2026-07-13 08:47:31" -> "2026-07-13T08:47:31+05:30" (a real instant)
    const deviceTsIso = `${rawTs.replace(" ", "T")}${deviceOffset}`;

    records.push({
      device_user_id: pin,
      device_ts: deviceTsIso,
      status: parts[2] !== undefined ? Number(parts[2]) : null,
      verify_mode: parts[3] !== undefined ? Number(parts[3]) : null,
      workcode: parts[4] ?? null,
      raw_line: line, // stored verbatim (spec: the original TSV line)
    });
  }
  return records;
}

/**
 * Parse the enrolled-user list pushed by the terminal in response to
 * "DATA QUERY USERINFO". Lines look like:
 *
 *   USER PIN=1\tName=Anshul\tPri=14\tPasswd=\tCard=4690305\tGrp=1\t...
 *
 * Only the User ID and name are taken. "FP PIN=..." lines carry fingerprint
 * templates and are ignored on purpose — biometric data is never stored.
 */
export function parseUserInfo(body) {
  const out = [];
  for (const rawLine of String(body || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("USER ")) continue; // skips "FP ", "OPLOG ", etc.
    const fields = {};
    for (const part of line.slice(5).split("\t")) {
      const i = part.indexOf("=");
      if (i > 0) fields[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    const pin = parseInt(fields.PIN, 10);
    if (!Number.isInteger(pin) || pin <= 0) continue;
    out.push({ pin, name: fields.Name || "" });
  }
  return out;
}

/**
 * Parse fingerprint METADATA from an "FP PIN=..." push.
 *
 *   FP PIN=12\tFID=6\tSize=1404\tValid=1\tTMP=<base64 template>
 *
 * Only PIN, FID and Valid are taken. The TMP field is the biometric template
 * and is never read, logged or stored — FID is just the slot the enroller
 * chose, which is ordinary metadata.
 *
 * ZKTeco finger indices:
 *   0 left little · 1 left ring · 2 left middle · 3 left index · 4 left thumb
 *   5 right thumb · 6 right index · 7 right middle · 8 right ring · 9 right little
 */
export const FINGER_NAMES = [
  "Left little", "Left ring", "Left middle", "Left index", "Left thumb",
  "Right thumb", "Right index", "Right middle", "Right ring", "Right little",
];

export function parseFingerprints(body) {
  const out = [];
  for (const rawLine of String(body || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("FP ")) continue;
    const fields = {};
    for (const part of line.slice(3).split("\t")) {
      const i = part.indexOf("=");
      if (i <= 0) continue;
      const key = part.slice(0, i).trim();
      if (key === "TMP") continue; // never touch the template
      fields[key] = part.slice(i + 1).trim();
    }
    const pin = parseInt(fields.PIN, 10);
    const fid = parseInt(fields.FID, 10);
    if (!Number.isInteger(pin) || pin <= 0 || !Number.isInteger(fid)) continue;
    out.push({ pin, fid, valid: fields.Valid !== "0" });
  }
  return out;
}

import express from "express";
import { config } from "./config.js";
import { parseAttlog, parseUserInfo, parseFingerprints } from "./parser.js";
import { Spool } from "./queue.js";
import { startDrainer } from "./forwarder.js";
import {
  refreshWorkerMap,
  refreshAllowedSerials,
  isKnownSerial,
  ensureDevice,
  touchDevice,
  upsertDeviceUsers,
  clearDeviceUsers,
  clearFingerprints,
  upsertFingerprints,
} from "./db.js";

const spool = new Spool(config.spoolDir);
const app = express();

// ADMS bodies are tab-separated plain text, not JSON. Capture everything as text.
app.use(express.text({ type: () => true, limit: "10mb" }));

const ok = (res, body = "OK") => res.status(200).type("text/plain").send(body);

/** Ensure the terminal's serial is one we accept; auto-register during setup. */
async function gateSerial(sn) {
  if (!sn) return false;
  if (isKnownSerial(sn)) return true;
  if (config.autoRegister) {
    await ensureDevice(sn);
    return true;
  }
  console.warn(`[server] rejected punch from UNKNOWN device SN=${sn} (set AUTO_REGISTER_DEVICES=true or add it in the app)`);
  return false;
}

// ── Registration handshake — device asks for its polling config (spec §2.1) ──
app.get("/iclock/cdata", async (req, res) => {
  const sn = req.query.SN;
  console.log(`[server] handshake SN=${sn} options=${req.query.options ?? ""}`);
  await gateSerial(sn);
  touchDevice(sn).catch(() => {});
  // Known-good option block. Realtime=1 → push attendance immediately.
  const cfg = [
    `GET OPTION FROM: ${sn}`,
    "Stamp=9999",
    "OpStamp=9999",
    "ErrorDelay=30",
    "Delay=10",
    "TransTimes=00:00;23:59",
    "TransInterval=1",
    "TransFlag=1111111111",
    "Realtime=1",
    "Encrypt=0",
  ].join("\r\n");
  ok(res, cfg + "\r\n");
});

// ── Attendance push — TSV body, one punch per line (spec §2.1) ───────────────
app.post("/iclock/cdata", async (req, res) => {
  const sn = req.query.SN;
  const table = String(req.query.table || "").toUpperCase();

  const accepted = await gateSerial(sn);
  if (!accepted) return ok(res, "OK: 0");

  if (table !== "ATTLOG") {
    // The enrolled-user list arrives as "USER PIN=..\tName=..\t.." lines. Real
    // firmware sends them under OPERLOG (not USERINFO), so scan any non-ATTLOG
    // push.
    const users = parseUserInfo(String(req.body || ""));
    if (users.length) {
      console.log(`[server] USERINFO SN=${sn} ${users.length} user(s): ${users.map((u) => `${u.pin}=${u.name}`).join(", ")}`);
      upsertDeviceUsers(sn, users).catch((e) => console.error(`[server] device_users: ${e.message}`));
    }

    // "FP PIN=.. FID=.. Valid=.. TMP=<template>" — the TEMPLATE is dropped by the
    // parser and never reaches here. Only the finger SLOT (FID) is kept, so an
    // admin can verify everyone enrolled the finger they were asked to.
    const fps = parseFingerprints(String(req.body || ""));
    if (fps.length) {
      console.log(`[server] FINGERPRINTS SN=${sn} ${fps.length} record(s)`);
      upsertFingerprints(sn, fps).catch((e) => console.error(`[server] device_fingerprints: ${e.message}`));
    }
    return ok(res, "OK");
  }

  const records = parseAttlog(req.body || "", config.deviceOffset);
  const serverTs = new Date().toISOString(); // gateway received-at (drift canary, §9)
  for (const r of records) r.server_ts = serverTs;

  // Durably buffer BEFORE acknowledging — never drop a punch.
  spool.enqueue(sn, records);
  console.log(`[server] ATTLOG SN=${sn} received ${records.length} punch(es); spool depth=${spool.depth()}`);

  ok(res, `OK: ${records.length}`);
});

// ── Command queue ────────────────────────────────────────────────────────────
// Commands we want the terminal to run, keyed by serial. The device picks them
// up on its next /iclock/getrequest poll (every few seconds).
const pending = new Map(); // sn -> string[]
let cmdSeq = Date.now() % 100000;

function queueCommand(sn, cmd) {
  const list = pending.get(sn) ?? [];
  list.push(`C:${++cmdSeq}:${cmd}`);
  pending.set(sn, list);
  return cmdSeq;
}

// ── Command poll — device asks if we have anything queued for it ─────────────
app.get("/iclock/getrequest", (req, res) => {
  const sn = req.query.SN;
  touchDevice(sn).catch(() => {});
  const list = pending.get(sn);
  if (list && list.length) {
    const batch = list.splice(0, list.length).join("\r\n");
    console.log(`[server] -> sending command(s) to ${sn}: ${batch.replace(/\r\n/g, " | ")}`);
    return ok(res, batch + "\r\n");
  }
  ok(res, "OK");
});

// ── Command acknowledgement ──────────────────────────────────────────────────
app.post("/iclock/devicecmd", (req, res) => {
  console.log(`[server] devicecmd ack SN=${req.query.SN}: ${String(req.body || "").slice(0, 200)}`);
  ok(res, "OK");
});

// ── Local admin: queue a command (NOT exposed publicly — nginx proxies only
// /iclock/, so this is reachable from the box itself). ───────────────────────
app.post("/admin/cmd", (req, res) => {
  const sn = String(req.query.sn || "");
  const cmd = String(req.query.cmd || "DATA QUERY USERINFO");
  if (!sn) return res.status(400).json({ error: "sn required" });

  // Re-reading the device's user list replaces our mirror rather than merging
  // into it, so users deleted on the terminal actually disappear here too.
  if (/^DATA\s+QUERY\s+USERINFO/i.test(cmd)) {
    clearDeviceUsers(sn).catch(() => {});
  }

  // Same reasoning for the fingerprint mirror: re-read it, never merge into it.
  if (/^DATA\s+QUERY\s+FINGERTMP/i.test(cmd)) {
    clearFingerprints(sn).catch(() => {});
  }

  const id = queueCommand(sn, cmd);
  res.json({ queued: true, id, sn, cmd });
});

// Health check for humans.
app.get("/health", (_req, res) =>
  res.json({ ok: true, spoolDepth: spool.depth(), time: new Date().toISOString() })
);

async function main() {
  await refreshAllowedSerials();
  await refreshWorkerMap();
  // Keep worker/serial maps fresh without a restart.
  setInterval(() => {
    refreshWorkerMap().catch(() => {});
    refreshAllowedSerials().catch(() => {});
  }, 5 * 60 * 1000);

  startDrainer(spool);

  app.listen(config.port, "0.0.0.0", () => {
    console.log(`[gateway] listening on http://0.0.0.0:${config.port}`);
    console.log(`[gateway] point each K40 Pro's ADMS server at this PC's LAN IP, port ${config.port}`);
    console.log(`[gateway] auto-register devices: ${config.autoRegister}`);
  });
}

main().catch((e) => {
  console.error("[gateway] fatal:", e);
  process.exit(1);
});

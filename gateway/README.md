# Warehouse Ops — Device Gateway (ZKTeco K40 Pro)

The gateway is a tiny Node service that runs on an **office PC on the same local
network as the fingerprint terminals**. It receives punches from the K40 Pro
devices over plain HTTP (ADMS/PUSH protocol), buffers them locally so nothing is
ever lost, and forwards them to your Supabase database — which then computes
attendance automatically.

```
K40 Pro terminals ──local WiFi/LAN──▶  THIS GATEWAY (office PC)  ──HTTPS──▶  Supabase
   (at the gate)      plain HTTP, TSV    store-and-forward buffer            raw_punches → recompute
```

**It must run on a machine the devices can reach on the LAN. It is never exposed
to the internet.** The web app (on the server) and this gateway both talk to the
same Supabase project; they don't talk to each other directly.

---

## What you need

- A **Windows PC** at the gate, on the **same WiFi/LAN** as the two K40 Pro devices, that stays on during working hours.
- **Node.js 20 or 22** installed on that PC — download the LTS installer from [nodejs.org](https://nodejs.org).
- The two devices already on the WiFi (they are).

## 1. Put the gateway on the office PC

Copy the whole `gateway/` folder (including the `.env` file, which already has your
Supabase settings) to the Windows PC, e.g. `C:\warehouse-gateway`.

Open **Command Prompt** (or PowerShell), then:

```bat
cd C:\warehouse-gateway
npm install
```

## 2. Give the PC a fixed address (important)

The terminals push to this PC by IP, so the IP must not change or they'll silently
stop syncing (spec §9). Either:
- set a **DHCP reservation** for this PC in your WiFi router (recommended), or
- give the PC a **static IP**.

Find the PC's current LAN IP:

```bat
ipconfig
```

Look for **IPv4 Address** under your active adapter, e.g. `192.168.1.50`. Write it
down — you'll enter it into the devices in step 5.

## 3. Open the firewall port

Allow the devices to reach the gateway on port **8080**:

- Windows Search → **"Windows Defender Firewall with Advanced Security"**
- **Inbound Rules → New Rule → Port → TCP → Specific local ports: 8080 → Allow the connection → (Domain/Private) → name it "Warehouse Gateway"**.

## 4. Test it

```bat
npm start
```

You should see `[gateway] listening on http://0.0.0.0:8080`. From the same PC,
open **http://localhost:8080/health** in a browser — it should return
`{"ok":true,...}`. Leave it running for the device test in step 6.

## 5. Point each K40 Pro at the gateway

On **each** terminal, at the device keypad:

1. **Main Menu → Comm.** (Communication) **→ Cloud Server Setting** (some firmware calls it **ADMS**).
2. Set:
   - **Server Mode:** `ADMS`
   - **Enable Domain Name:** `OFF`
   - **Server Address:** the PC's LAN IP from step 2 (e.g. `192.168.1.50`)
   - **Server Port:** `8080`
   - **Enable Proxy Server:** `OFF`
3. **Save.** The device will connect and start pushing. (If it doesn't within a
   minute, reboot the terminal: **Main Menu → System → Reset** is not needed —
   just power-cycle.)

Also make sure the device **clock/timezone is set to India (GMT+5:30)** — Main
Menu → System → Date & Time. The gateway assumes device time is +05:30.

## 6. Enroll fingerprints — and match the PIN to the app

For each worker, on the device: **Main Menu → User Mgt. → New User**:
- **User ID:** a number (e.g. `1001`) — **remember this number**.
- **Fingerprint:** enroll one or two fingers.
- Save.

Then in the web app go to **Employees → Device PINs** (`/workers/pins`, admin only)
and set that employee's **Device PIN = the same User ID** you set on the device.
This mapping is how a punch becomes "Ramesh worked today." If they don't match, the
punch is stored but not linked to a worker.

The PIN is *not* collected on the new-employee form — enrolment is an admin/IT step,
so it lives on the Device PINs screen. That screen also lists **User IDs that have
punched but aren't mapped to anyone**, which is the easiest way to do this: enrol
everyone on the device first, have them punch once, then map the PINs it reports.
Assigning a PIN backfills that person's earlier punches (see migration 0029) — hit
**Recompute attendance** on that screen afterwards.

> The seed created sample workers with PINs 1001–1004. Replace them with your real
> workers (or reuse those PINs when enrolling) — and delete the sample workers when
> you go live.

## 7. Verify end to end

- Have someone punch on a terminal.
- Watch the gateway window — you should see `[server] ATTLOG SN=... received 1 punch(es)`.
- In the web app: **Admin → Attendance** (set today's date) shows the worker, and
  **Admin → Dashboard** shows the device as recently seen. A first punch with no
  second punch shows as `unresolved` until they punch out — that's correct.

## 8. Keep it running on boot (Windows service)

So it starts automatically and survives reboots, install it as a service with
**NSSM** (free):

1. Download NSSM from [nssm.cc](https://nssm.cc/download), unzip, and from the
   `win64` folder run:
   ```bat
   nssm install WarehouseGateway
   ```
2. In the dialog:
   - **Path:** `C:\Program Files\nodejs\node.exe`
   - **Startup directory:** `C:\warehouse-gateway`
   - **Arguments:** `src\server.js`
   - **Install service**, then **start** it (`nssm start WarehouseGateway`).

Now the gateway runs in the background from boot. Logs: NSSM can redirect stdout to
a file (I/O tab), or check with `nssm status WarehouseGateway`.

---

## How it behaves (good to know)

- **Never drops a punch.** Every batch is written to `spool/` on disk before the
  device is acknowledged. If the internet or Supabase is down, punches pile up in
  `spool/` and a background loop retries with backoff until they're delivered. The
  devices themselves also buffer ~100k records, so even the gateway being off just
  *delays* sync — nothing is lost.
- **Idempotent.** Re-sending after a crash can't create duplicate punches (a unique
  index ignores them), and the app's 2-minute dedupe window collapses finger-retries.
- **Read-only to the device.** v1 sends no commands to the terminals; it only
  receives punches. (User-enroll push can be added later via the command channel —
  note ZKTeco needs `DATA UPDATE USERINFO`, not `USER ADD`.)
- **The gateway does no business logic.** It's a pipe. All rules (pairing, dedupe,
  classification, payroll) live in Supabase.

## Configuration (`gateway/.env`)

| Key | Meaning |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | your Supabase project + secret key |
| `GATEWAY_PORT` | port the devices push to (default 8080) |
| `DEVICE_TZ_OFFSET` | device clock offset, `+05:30` for India |
| `WAREHOUSE_TZ` | calendar-day timezone (`Asia/Kolkata`) |
| `ALLOWED_SERIALS` | restrict to specific device serials (blank = learn from DB) |
| `AUTO_REGISTER_DEVICES` | add unknown terminals on first contact (turn off after setup) |

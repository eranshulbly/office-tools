# Warehouse Ops Platform — Build Specification

**For:** Claude Code
**Stack:** Supabase (Postgres + Auth + RLS) · Next.js (App Router) · Node gateway
**Scale:** ~100 workers, ~200 punches/day, 1 payroll run/month. Free tier is sufficient.

> **Read this section first.** This is a **payroll system**. It moves real money to real people. Correctness and auditability beat cleverness and speed at every single decision point. Two non-negotiable invariants:
>
> 1. **`raw_punches` is append-only.** No UPDATE, no DELETE, no exceptions, no role. It is the immutable record of what the biometric device said.
> 2. **`attendance_days` is derived.** It must be possible to `TRUNCATE` it and rebuild it entirely from `raw_punches` + approved `adjustments` + `work_calendar`. Every rule lives in a recompute function, never in an UPDATE statement.
>
> If you find yourself writing code that mutates a punch, stop. You are doing it wrong.

---

## 1. Product shape

One web app, several modules, one database, one auth system. More modules will be added later (inventory, purchase, etc.), so build for that.

**This is a modular monolith. Not microservices.** Payroll does not call an "attendance API" — payroll runs a SQL join against the attendance tables in the same database. That is the entire point.

```
/app
  /(auth)              login
  /admin               admin shell
  /manager             manager shell
/modules
  /attendance          punches, days, adjustments, calendar
  /payroll             runs, lines, disbursal
  /advances            requests, approvals, ledger
  /core                workers, settings, audit, auth
/gateway               separate Node service — runs on the office PC
```

### Roles

| Role | Can |
|---|---|
| `admin` | Approve/reject everything. Run payroll. Edit settings and calendar. See all audit trails. |
| `manager` | *Request* adjustments and advances. Disburse approved salary. **Approve nothing.** |
| worker | No login. Punches at the terminal only. |

**The control model:** the manager is the person closest to the money, so he can request but never approve. Every path that changes what someone gets paid passes through the admin. Enforce this in **RLS policies**, not just in UI or route guards.

---

## 2. Hardware integration (settled — build to this)

- **2 × ZKTeco K40 Pro**, fingerprint-only, WiFi, both at one gate.
- Devices speak **ADMS / PUSH SDK** over **plain HTTP** to the gateway on the local network.
- The gateway is a small Node service on the office PC. It forwards to Supabase over **HTTPS with a service key**.
- **Devices are never exposed to the internet.**
- Devices match fingerprints locally and buffer ~100k records. **Punching works when the internet, the gateway, and the mains are all down.** The gateway going offline is not an incident — it just delays sync.

### 2.1 Gateway responsibilities

Implement three ADMS endpoints. Payloads are **tab-separated plain text**, not JSON.

| Endpoint | Method | Purpose |
|---|---|---|
| `/iclock/cdata?SN=…&options=all` | GET | Device registration handshake. Reply with polling config. |
| `/iclock/cdata?SN=…&table=ATTLOG` | POST | Attendance push. Body is TSV. Reply `OK: <count>`. |
| `/iclock/getrequest?SN=…` | GET | Device polls for queued commands. Reply `C:<id>:<cmd>` or `OK`. |
| `/iclock/devicecmd` | POST | Device acknowledges a command. `Return=0` means success. |

**ATTLOG body format** — one record per line:
```
1042	2026-07-13 08:47:31	0	1	0
```
`device_user_id` · `timestamp` · `status` · `verify_mode` · `workcode`

**Gateway rules:**
- Store-and-forward. Buffer to local SQLite when Supabase is unreachable; retry with backoff until confirmed. Never drop a punch.
- Forward with **both** the device timestamp and the gateway's received-at timestamp.
- Reject pushes from unknown serial numbers.
- Do not parse or interpret. The gateway is a pipe. All business logic is server-side.

**Command channel gotcha:** ZKTeco docs say `USER ADD` / `USER DEL`. Real devices reject those with error `-1002`. Use `DATA UPDATE USERINFO` and `DATA DELETE USERINFO` — the word DELETE must be spelled in full.

**Do not write the ADMS parser from scratch.** Adapt an existing implementation (e.g. `github.com/s0x90/zkteco-adms` for reference on the protocol shape).

---

## 3. Business rules — THE SPEC

Every threshold below is a **row in the `settings` table**, editable by the admin in the UI. Nothing here is a magic number in code.

### 3.1 Day classification

Hours are **clock-to-clock**: first punch of the day is IN, last punch is OUT.

| Hours worked | Status | Setting |
|---|---|---|
| `>= 7` | `full_day` | `full_day_hours = 7` |
| `>= 4` and `< 7` | `half_day` | `half_day_hours = 4` |
| `< 4` | `absent` | — |
| No punches at all on a working day | `absent` | — |

Minus `break_deduction_minutes` (default `0`) from total hours before classifying.

**Critical parsing rules:**
- **Ignore the device's IN/OUT status flag entirely.** Workers press it wrong. Pair chronologically instead.
- **Dedupe window:** punches from the same worker within `dedupe_window_minutes` (default `2`), across *any* device, collapse to one event. Required because a worker whose finger fails on terminal 1 immediately retries on terminal 2.
- **No shift crosses midnight.** Attendance is per calendar day. (Confirmed — if this ever changes, the model must move to shift-windows.)

### 3.2 Working calendar — REQUIRED MODULE

The warehouse does **not** have a fixed weekly off. The admin marks days on a calendar. Payroll is wrong without this.

| Day type | `is_working` | `pays_extra` | Meaning |
|---|---|---|---|
| `working` | ✅ | ❌ | Normal day. Absence counts as a leave. |
| `closed` | ❌ | ❌ | Warehouse shut. No attendance expected, no absence recorded. |
| `extra_working` | ✅ | ✅ | Sunday opened as a **genuine extra day**. Attending earns **+1 day's pay**. |
| `swapped_working` | ✅ | ❌ | Sunday opened **because a weekday was closed**. A normal working day. No extra pay. |

**Defaults on seed:** Sunday = `closed`, Mon–Sat = `working`. Admin overrides per date.

The system **cannot infer** `extra_working` from `swapped_working` — the punch data looks identical. Only the admin knows. Do not try to guess.

**Absence on an `extra_working` day does NOT count as a leave** (setting: `extra_day_absence_counts_as_leave = false`). The worker simply forgoes the extra pay.

### 3.3 Payroll calculation

**Pay model:** fixed monthly salary per worker. Not daily wage.

**Period:** the **10th of month M−1 through the 9th of month M**, paid on the **10th of month M**. The pay date is admin-adjustable — the 10th is a default, not a constraint.

**Daily rate is a fixed divisor, always:**
```
daily_rate = monthly_salary / 30
```
Not ÷26, not ÷actual-days. Always 30, regardless of how many days the period contains. Setting: `daily_rate_divisor = 30`.

**The leave-units formula. This is the heart of the system:**

```
leave_units = absent_days + (0.5 × half_days)     # working days only

if leave_units <= free_leave_units:               # free_leave_units = 1
    deduction = 0
else:
    deduction = leave_units × daily_rate          # ALL units, not just the excess

extra_pay = extra_days_worked × daily_rate        # days marked extra_working

net = monthly_salary - deduction + extra_pay - advance_recovery
```

**Note the cliff, and do not "fix" it.** Going from 1 leave to 2 leaves costs the worker *two* days' pay, not one — the free leave is lost retroactively. This is intentional client policy. Implement it exactly as written.

**Overtime is not paid.** A worker doing 12 hours a day all month earns his salary and nothing more. Do not build an OT engine.

### 3.4 Acceptance tests — payroll engine

Write these as unit tests first. Salary = ₹15,000 → daily rate = ₹500.

| # | Month's attendance | `leave_units` | Deduction | Net |
|---|---|---|---|---|
| 1 | Perfect attendance | 0 | ₹0 | ₹15,000 |
| 2 | 1 half-day only | 0.5 | ₹0 | ₹15,000 |
| 3 | 1 leave only | 1.0 | ₹0 | ₹15,000 |
| 4 | 2 half-days | 1.0 | ₹0 | ₹15,000 |
| 5 | 1 leave + 1 half-day | 1.5 | ₹750 | ₹14,250 |
| 6 | 2 leaves | 2.0 | ₹1,000 | ₹14,000 |
| 7 | 3 leaves | 3.0 | ₹1,500 | ₹13,500 |
| 8 | 3 half-days | 1.5 | ₹750 | ₹14,250 |
| 9 | Perfect + 1 `extra_working` Sunday worked | 0 | ₹0 | **₹15,500** |
| 10 | Perfect + 1 `swapped_working` Sunday worked | 0 | ₹0 | ₹15,000 |
| 11 | 12h every day, perfect attendance | 0 | ₹0 | ₹15,000 (no OT) |
| 12 | 2 leaves + ₹3,000 advance outstanding | 2.0 | ₹1,000 | ₹11,000 |

### 3.5 Forgot-punch adjustments

1. Manager raises a request: worker, date, missing IN and/or OUT time, **mandatory reason**.
2. Routes to admin. Approve or reject (rejection requires a reason).
3. **Only on approval** does it affect `attendance_days`. Pending requests have zero effect on pay.
4. **Raw punches are never touched.** The adjustment is an additive record carrying `requested_by` and `approved_by`.
5. Adjustments are **blocked** for any period belonging to a `closed` payroll run.

**Manual-entry control (important):** maintain a per-worker count of approved adjustments per period. Surface workers exceeding `manual_entry_alert_threshold` (default 3) on the admin dashboard.

*Why this exists:* fingerprint-only capture means a few workers with worn prints will genuinely need manual entry — that's accepted. This counter exists so that "2–3 workers" cannot quietly become 20, and so manual entry never becomes a route to ghost attendance. It is the primary fraud control in the system.

### 3.6 Dangling punches — BLOCKS PAYROLL

A worker punched IN, never punched OUT, and nobody filed an adjustment.

**Do not auto-resolve.** Do not silently mark absent. Do not silently mark half-day.

- Flag the day as `unresolved`.
- **Payroll refuses to run** while any `unresolved` day or any *pending* adjustment exists in the period.
- The admin sees an exceptions list and must clear every one before the run can proceed.

Rationale: silently guessing turns a data problem into a pay decision nobody made.

### 3.7 Advances

1. Manager raises a request: worker, amount, **mandatory reason**.
2. Admin sees the worker's **current outstanding balance** and history at the point of decision.
3. **Hard cap:** `outstanding_balance + requested_amount` must not exceed the worker's monthly salary. If it does, **block the request** — do not warn and allow. (Setting: `advance_cap_multiple = 1.0`.)
4. Approval ≠ payment. The manager separately records handing over the cash (`disbursed_at`).
5. **Recovery: the full outstanding amount is deducted from the very next payroll.** No installments.

### 3.8 Salary run lifecycle

| State | Advanced by | Meaning |
|---|---|---|
| `draft` | System / admin | Calculated. Admin-only. Freely recomputable. |
| `admin_approved` | Admin | **Figures frozen.** Now visible to the manager. |
| `disbursing` | Manager | Lines being marked paid. |
| `closed` | System (all lines paid) or admin | Period locked. No adjustments permitted. |

- Admin approves the run **as a whole**, but can hold individual lines for correction.
- Reopening an `admin_approved` run is possible but **logged loudly**.
- A run **cannot close** while any line is unpaid.

### 3.9 Disbursal

- Manager sees each approved line as payable.
- Marks each one paid: **`cash`** or **`online`**.
- **Online in v1 = the manager transfers manually via his own bank app, then marks the line paid in the system, one by one.** No bank file, no payout API. An optional reference field is available but not mandatory.
- **Partial disbursal is required** — he will not pay 100 people in one sitting.
- Admin sees live reconciliation: approved total vs disbursed vs outstanding, with the list of unpaid workers.

### 3.10 Statutory deductions — DESIGN FOR, DO NOT BUILD

The client does **not** currently deduct PF or ESI. However — an establishment of ~100 workers in India may well fall under EPF and ESI thresholds, and this is being checked with a CA.

**Therefore: do not hardcode `net = gross - deduction - advance` as fixed columns.**

Build `payroll_line_components` as a child table: each line has N components of type `earning` or `deduction`. Today it holds `base_salary`, `leave_deduction`, `extra_days`, `advance_recovery`. Tomorrow `pf_employee`, `esi_employee` slot in **without a schema migration**.

`payroll_lines.net` is the sum of its components. That's the whole design.

---

## 4. Database schema

Postgres via Supabase. Write as migrations.

```sql
-- ============ CORE ============

create type user_role as enum ('admin', 'manager');

create table profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text not null,
  role user_role not null,
  created_at timestamptz default now()
);

create table settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_at timestamptz default now(),
  updated_by uuid references profiles(id)
);

create table workers (
  id uuid primary key default gen_random_uuid(),
  employee_code text unique not null,
  full_name text not null,
  device_user_id int unique not null,   -- the PIN enrolled on the K40 Pro
  monthly_salary numeric(10,2) not null check (monthly_salary > 0),
  bank_account text,
  bank_ifsc text,
  joined_on date not null,
  left_on date,
  is_active boolean not null default true,
  created_at timestamptz default now()
);

create table devices (
  serial_number text primary key,
  label text not null,
  last_seen_at timestamptz,
  last_device_time timestamptz,          -- for clock-drift detection
  is_active boolean default true
);

-- ============ ATTENDANCE ============

-- APPEND ONLY. No UPDATE. No DELETE. Enforced by RLS + trigger.
create table raw_punches (
  id bigserial primary key,
  device_serial text not null references devices(serial_number),
  device_user_id int not null,
  worker_id uuid references workers(id),   -- resolved on ingest; null if unknown
  device_ts timestamptz not null,          -- what the device said
  server_ts timestamptz not null default now(),
  verify_mode smallint,
  raw_line text not null,                  -- the original TSV line, verbatim
  created_at timestamptz default now()
);
create index on raw_punches (worker_id, device_ts);

create type calendar_day_type as enum
  ('working', 'closed', 'extra_working', 'swapped_working');

create table work_calendar (
  day date primary key,
  day_type calendar_day_type not null default 'working',
  note text,
  updated_by uuid references profiles(id),
  updated_at timestamptz default now()
);

create type day_status as enum
  ('full_day', 'half_day', 'absent', 'unresolved', 'not_working_day');

-- DERIVED. Safe to TRUNCATE and rebuild from raw_punches + adjustments + calendar.
create table attendance_days (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references workers(id),
  day date not null,
  first_in timestamptz,
  last_out timestamptz,
  worked_hours numeric(5,2),
  status day_status not null,
  is_from_adjustment boolean not null default false,
  computed_at timestamptz not null default now(),
  unique (worker_id, day)
);
create index on attendance_days (day, status);

create type request_status as enum ('pending', 'approved', 'rejected');

create table adjustments (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references workers(id),
  day date not null,
  proposed_in timestamptz,
  proposed_out timestamptz,
  reason text not null,
  status request_status not null default 'pending',
  requested_by uuid not null references profiles(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  decision_reason text
);

-- ============ ADVANCES ============

create table advances (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references workers(id),
  amount numeric(10,2) not null check (amount > 0),
  reason text not null,
  status request_status not null default 'pending',
  requested_by uuid not null references profiles(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  decision_reason text,
  disbursed_at timestamptz,               -- approval != payment
  recovered_in_run uuid                   -- FK to payroll_runs, set on recovery
);

-- ============ PAYROLL ============

create type run_status as enum
  ('draft', 'admin_approved', 'disbursing', 'closed');

create table payroll_runs (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,             -- 10th of M-1
  period_end date not null,               -- 9th of M
  pay_date date not null,                 -- default 10th of M, admin-adjustable
  status run_status not null default 'draft',
  computed_at timestamptz,
  approved_by uuid references profiles(id),
  approved_at timestamptz,
  closed_at timestamptz,
  unique (period_start, period_end)
);

create type pay_mode as enum ('cash', 'online');

create table payroll_lines (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references payroll_runs(id) on delete cascade,
  worker_id uuid not null references workers(id),

  -- SNAPSHOTS. Never read these from workers at display time.
  salary_snapshot numeric(10,2) not null,
  daily_rate_snapshot numeric(10,2) not null,

  full_days int not null default 0,
  half_days int not null default 0,
  absent_days int not null default 0,
  extra_days int not null default 0,
  leave_units numeric(5,2) not null default 0,

  net numeric(10,2) not null,             -- = sum(components)

  pay_mode pay_mode,
  paid_at timestamptz,
  paid_by uuid references profiles(id),
  payment_reference text,                 -- optional UTR
  unique (run_id, worker_id)
);

create type component_type as enum ('earning', 'deduction');

-- Extensible: PF/ESI slot in here later with no migration.
create table payroll_line_components (
  id uuid primary key default gen_random_uuid(),
  line_id uuid not null references payroll_lines(id) on delete cascade,
  code text not null,      -- base_salary | leave_deduction | extra_days | advance_recovery | pf_employee | ...
  label text not null,
  type component_type not null,
  amount numeric(10,2) not null
);

-- ============ AUDIT ============

create table audit_log (
  id bigserial primary key,
  actor_id uuid references profiles(id),
  action text not null,
  entity_table text not null,
  entity_id text not null,
  before_value jsonb,
  after_value jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index on audit_log (entity_table, entity_id);
create index on audit_log (actor_id, created_at);
```

### 4.1 Seed `settings`

```
full_day_hours                    = 7
half_day_hours                    = 4
break_deduction_minutes           = 0     -- confirm with client
dedupe_window_minutes             = 2
free_leave_units                  = 1
daily_rate_divisor                = 30
overtime_enabled                  = false
extra_day_absence_counts_as_leave = false
advance_cap_multiple              = 1.0
payroll_period_start_day          = 10
payroll_period_end_day            = 9
payroll_pay_day                   = 10
manual_entry_alert_threshold      = 3
device_offline_alert_hours        = 2
clock_drift_alert_minutes         = 5
```

---

## 5. Row Level Security

RLS is the real permission system. Route guards are cosmetic — assume they can be bypassed.

**Enable RLS on every table.** Then:

| Table | admin | manager |
|---|---|---|
| `raw_punches` | SELECT only | SELECT only |
| `attendance_days` | SELECT only | SELECT only |
| `work_calendar` | ALL | SELECT |
| `adjustments` | SELECT, UPDATE (decide) | SELECT, INSERT (request) |
| `advances` | SELECT, UPDATE (decide) | SELECT, INSERT, UPDATE (`disbursed_at` only) |
| `payroll_runs` | ALL | SELECT (only `admin_approved`+) |
| `payroll_lines` | ALL | SELECT + UPDATE (payment fields only) |
| `settings` | ALL | SELECT |
| `workers` | ALL | SELECT |
| `audit_log` | SELECT | — |

**Hard requirements:**
- **Nobody** gets UPDATE or DELETE on `raw_punches`. Add a trigger that raises an exception on either. Belt and braces.
- `attendance_days` is written **only** by the recompute function (`security definer`). No role writes it directly.
- The manager cannot set `adjustments.status` or `advances.status`. Enforce with a column-level policy or a `security definer` RPC that checks `role = 'admin'`.
- The manager cannot change `payroll_lines` figures — only `pay_mode`, `paid_at`, `paid_by`, `payment_reference`.

---

## 6. Core functions

### `recompute_attendance(from_date, to_date)`
`security definer`. The only writer of `attendance_days`.

```
for each working day in range (per work_calendar):
    for each active worker:
        punches = raw_punches for (worker, day)
        punches = dedupe(punches, dedupe_window_minutes)
        adjustment = approved adjustment for (worker, day)

        if calendar day is 'closed':          status = not_working_day; continue
        if no punches and no adjustment:      status = absent
        if adjustment exists:                 use its times; is_from_adjustment = true
        if exactly one punch and no adjustment: status = unresolved   -- BLOCKS PAYROLL
        else:
            first_in  = min(punches)
            last_out  = max(punches)
            hours     = (last_out - first_in) - break_deduction_minutes
            status    = full_day  if hours >= full_day_hours
                        half_day  if hours >= half_day_hours
                        absent    otherwise
    upsert into attendance_days
```

Must be idempotent. Running it twice produces identical output.

### `compute_payroll_run(run_id)`
```
guard: no 'unresolved' days in period          → else raise
guard: no 'pending' adjustments in period      → else raise

for each active worker:
    daily_rate  = monthly_salary / daily_rate_divisor
    absent_days = count(status = absent   on is_working days, excluding extra_working)
    half_days   = count(status = half_day on is_working days)
    extra_days  = count(status in (full_day, half_day) on extra_working days)

    leave_units = absent_days + 0.5 * half_days
    deduction   = 0  if leave_units <= free_leave_units
                  else leave_units * daily_rate

    advance_recovery = sum(approved, disbursed, unrecovered advances)

    components:
        + base_salary       (earning)   monthly_salary
        + extra_days        (earning)   extra_days * daily_rate
        - leave_deduction   (deduction) deduction
        - advance_recovery  (deduction) advance_recovery

    net = sum(earnings) - sum(deductions)
```

### `approve_payroll_run(run_id)`
Admin only. Freezes figures, sets `admin_approved`, marks recovered advances against this run, writes audit.

---

## 7. Screens

### Admin
- **Dashboard** — today's punches, device health (last seen, drift), open adjustment requests, open advance requests, exceptions (unresolved days), high-manual-entry workers.
- **Attendance** — day grid by worker; drill into raw punches; recompute button (date range).
- **Calendar** — mark days `working` / `closed` / `extra_working` / `swapped_working`. Must be obvious and hard to get wrong: warn loudly when marking `extra_working`, since it costs a day's pay per worker.
- **Approvals** — adjustment and advance queues, with worker context (manual-entry count; outstanding balance).
- **Payroll** — run list; per-worker breakdown with component lines; approve; reconciliation view.
- **Workers** — CRUD, `device_user_id` mapping, salary, bank details.
- **Settings** — all of §4.1, editable.
- **Audit** — filterable by actor, date, entity.

### Manager
- **Dashboard** — who's in today, who hasn't punched.
- **Request adjustment** — worker, date, times, reason.
- **Request advance** — worker, amount, reason. Shows outstanding balance and **blocks** if it would breach the cap.
- **Disburse** — approved payroll lines; mark paid (cash/online) one by one; progress against total.

Keep the UI plain and dense. This is an internal tool used daily by two people, not a marketing site.

---

## 8. Build order

1. Supabase project, migrations, RLS, seed settings, seed calendar (Sundays closed).
2. Auth + roles + profiles.
3. Workers CRUD.
4. **Gateway** — ADMS endpoints, local SQLite buffer, forward to Supabase. Test against a real K40 Pro before anything else.
5. `recompute_attendance` + unit tests.
6. **Payroll engine + the 12 acceptance tests in §3.4.** These must pass before any payroll UI exists.
7. Adjustments workflow.
8. Advances workflow.
9. Payroll run lifecycle + disbursal.
10. Calendar UI.
11. Audit log + admin dashboards.

---

## 9. Known operational gotchas — encode these

- **+5:30 timezone bug.** Some ZKTeco firmware mishandles half-hour timezones once WiFi + ADMS are both on; the device clock silently drifts. Store everything **UTC**. Store `device_ts` *and* `server_ts` separately and **alert on divergence** beyond `clock_drift_alert_minutes`. This is your canary.
- **DHCP.** The gateway PC must have a **static IP or DHCP reservation**, or the terminals will silently stop syncing to an address that no longer exists. Document this in the README.
- **Device offline alert.** Alert the admin if a device hasn't checked in for `device_offline_alert_hours` during working hours. A dead terminal that nobody notices means a day of manual entries.

---

## 10. Deliberately out of scope for v1

Do not build these. Do not "helpfully" add them.

- Overtime engine (client explicitly does not pay OT)
- Leave balances / leave types (the model is leave-*units*, computed from attendance)
- Worker self-service portal
- Shift rostering
- Bank bulk-upload files or payout APIs
- Face recognition / RFID fallback
- Multiple gates or sites
- PF/ESI **calculation** — but the component model in §3.10 must be there so it can be added without migration
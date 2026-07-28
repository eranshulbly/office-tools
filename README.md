# Warehouse Ops Platform

A modular monolith for warehouse attendance → payroll → advances. One Next.js
app, one Supabase (Postgres + Auth + RLS) database. Built to the spec in
[`requirement.md`](./requirement.md).

> **This is a payroll system. It moves real money.** Two invariants are enforced
> in the database, not just in code:
> 1. **`raw_punches` is append-only** — a trigger raises on any UPDATE/DELETE.
> 2. **`attendance_days` is derived** — written only by `recompute_attendance()`;
>    safe to `TRUNCATE` and rebuild from `raw_punches` + approved `adjustments` +
>    `work_calendar`.

The **gateway** (ADMS/PUSH service for the ZKTeco K40 Pro terminals) is **out of
scope for this build** — it needs a physical device on a local network to test.
The schema, ingest contract (`raw_punches`), and device tables are all in place
for it to write to later.

## Stack

- **Next.js 15** (App Router) + **TypeScript** + **Tailwind v4**
- **Supabase**: Postgres, Auth, Row Level Security
- **Vitest** integration tests against Postgres (payroll/attendance logic lives in SQL)

## Access model

Two roles, enforced by **RLS** (route guards are cosmetic):

| Role | Can |
|---|---|
| `admin` | Approve/reject everything. Run payroll. Edit settings & calendar. See audit. |
| `manager` | *Request* adjustments & advances. Disburse approved salary. **Approve nothing.** |
| worker | No login — punches at the terminal only. |

The **home page** is a grid of tiles. Which tiles appear is driven by the
logged-in user's role via a single registry ([`src/lib/tiles.ts`](./src/lib/tiles.ts)),
which also backs the top nav and each page's `requireRole()` guard — one source
of truth mirroring the database RLS.

## Setup

### 1. Fill in credentials

Copy your Supabase project values into `.env.local` (already created, git-ignored):

```
NEXT_PUBLIC_SUPABASE_URL=…         # Project Settings → API
NEXT_PUBLIC_SUPABASE_ANON_KEY=…    # Project Settings → API
SUPABASE_SERVICE_ROLE_KEY=…        # Project Settings → API (secret!)
DATABASE_URL=…                     # Project Settings → Database → Connection string (URI)
SEED_ADMIN_PASSWORD=…              # choose
SEED_MANAGER_PASSWORD=…            # choose
```

### 2. Install, migrate, seed

```bash
npm install
npm run db:push     # apply supabase/migrations/*.sql (idempotent)
npm run db:seed     # create admin + manager users, sample workers/devices
npm run dev         # http://localhost:3000
```

Sign in with `SEED_ADMIN_EMAIL` / `SEED_MANAGER_EMAIL` and the passwords you set.

`npm run db:reset` tears down our objects and re-applies all migrations (dev only).

### 3. Run the payroll acceptance tests

```bash
npm test
```

`tests/payroll.spec.ts` implements the **12 acceptance cases from spec §3.4**;
`tests/recompute.spec.ts` covers attendance rules (dedupe, dangling punches,
closed days, adjustments, idempotency) and the payroll guards. They connect to
`DATABASE_URL` and exercise the real SQL functions — run `db:push` and `db:seed`
first.

## Project layout

```
supabase/migrations/     0001 schema · 0002 RLS + triggers · 0003 functions · 0004 seed
scripts/                 db-push.ts (migrations) · seed.ts (users + sample data)
src/lib/                 supabase clients · auth · tiles registry · types
src/app/(auth)/login     login
src/app/(app)/           app shell + all module screens (home = tile grid)
  dashboard  attendance  calendar  approvals  payroll  disburse
  workers    settings    audit     adjustments  advances
tests/                   Vitest integration tests
```

## Core SQL functions (the engine)

- `recompute_attendance(from, to)` — the only writer of `attendance_days`. Dedupes
  punches, pairs clock-to-clock, applies approved adjustments, flags dangling
  punches `unresolved`. Idempotent.
- `compute_payroll_run(run_id)` — computes lines + components for a draft run.
  Refuses to run while any `unresolved` day or `pending` adjustment exists in the
  period (spec §3.6).
- `approve_payroll_run(run_id)` — freezes figures, marks recovered advances, audits.
- Plus `decide_adjustment`, `decide_advance`, `record_disbursal`,
  `record_advance_disbursal`, `reopen_payroll_run`.

Every threshold is a row in `settings`, editable in the admin UI — no magic
numbers in code.

## Payroll math (spec §3.3)

```
daily_rate  = monthly_salary / 30            # always ÷30
leave_units = absent_days + 0.5 × half_days  # normal working days
deduction   = 0 if leave_units ≤ 1 else leave_units × daily_rate   # the cliff is intentional
extra_pay   = extra_days_worked × daily_rate # only extra_working days
net         = salary + extra_pay − deduction − advance_recovery
```

`net` is the **sum of `payroll_line_components`** (earning/deduction rows), so
PF/ESI can be added later with no schema migration (spec §3.10).

### ⚠️ One spec ambiguity resolved — please confirm

Spec §6 says `half_days = count(status = half_day on is_working days)` but
`absent_days` explicitly *excludes* `extra_working`. Read literally, a half-day
on an `extra_working` day would count **both** as a leave penalty *and* as extra
pay. That contradicts `extra_day_absence_counts_as_leave = false` (an extra day
should only ever *add* pay). **This build excludes `extra_working` days from both
absent and half leave counting** (leave is computed on `working` + `swapped_working`
only). All 12 acceptance tests pass under either reading. See the comment in
[`0003_functions.sql`](./supabase/migrations/0003_functions.sql). Tell me if the
literal reading is actually wanted.

## Worker photos & identity proof

Each worker can carry a **face photo** and **one identity proof**, both optional
at enrollment and addable later (Workers → add/edit):

- **Face photo** — private `worker-photos` bucket, viewable by **any staff**
  (admin + manager), served via short-lived signed URLs. Shown as an avatar
  across the Workers list, worker detail, dashboards, payroll breakdown,
  disburse and approvals — so you can recognise a person by face, not just name.
- **Identity proof** — private `worker-id-proofs` bucket, **admin-only** (never
  visible to the manager). Image or PDF. Opened via a signed URL from the worker
  detail page.

Storage buckets and their RLS live in
[`0005_worker_photos.sql`](./supabase/migrations/0005_worker_photos.sql); helpers
in [`src/lib/storage.ts`](./src/lib/storage.ts); the avatar component in
[`src/components/WorkerAvatar.tsx`](./src/components/WorkerAvatar.tsx). Where a
worker has no photo, a circle with their initials is shown.

### Keeping Supabase egress low (free-tier friendly)

Worker photos are the only real driver of egress. Four controls keep it tiny:

1. **Browser-side resize on upload** — photos are downscaled to ~256 px and
   re-encoded (WebP/JPEG) in the browser *before* upload, so each is ~20–40 KB
   instead of megabytes. (`resizeImage` in `WorkerForm.tsx`.)
2. **Lazy loading + pagination** — avatars use `loading="lazy"`; the Workers list
   pages at 50/row, so a screen never pulls 100 images at once.
3. **Stable, cached signed URLs + long `cacheControl`** — photo URLs are signed
   for 7 days and reused (server-side cache) so the browser serves repeat views
   from its own cache instead of re-downloading. (`src/lib/storage.ts`.)
4. **Query hygiene** — `raw_punches` is only ever hit as a `head:true` count or a
   single-column, day-bounded read; no `select("*")` row pulls on big tables.

Net effect: a full dashboard of 100 faces is a few MB, not hundreds — comfortably
inside the free tier's monthly egress for daily use by two people.

## Operational notes (spec §9)

- **Store everything UTC.** `raw_punches` keeps both `device_ts` and `server_ts`;
  the admin dashboard flags divergence beyond `clock_drift_alert_minutes` (the
  ZKTeco +5:30 clock-drift canary). Calendar-day boundaries use the warehouse
  timezone setting (`warehouse_timezone`, default `Asia/Kolkata`).
- **Static IP / DHCP reservation** for the gateway PC is required so terminals
  don't lose their sync target (relevant when the gateway is built).
- **Device offline alert** after `device_offline_alert_hours` of no check-in.

## Out of scope (spec §10 — do not add)

Overtime engine · leave balances/types · worker self-service · shift rostering ·
bank bulk-upload/payout APIs · face/RFID · multiple gates · PF/ESI *calculation*
(the component model is present so it can be added without migration).

# ai.md — AI working guide for this repo

Read this **before touching anything**. It encodes the architecture, the non‑obvious
invariants, and the mistakes that have already been made and fixed. This is a
**payroll system — it moves real money.** Correctness and auditability beat
cleverness. When in doubt, re‑read the relevant section and run the test harnesses.

---

## 0. TL;DR guardrails (the mistakes people actually make)

1. **Use Node 22.** The default shell here is Node 16, which cannot build/run Next 15.
   Every command must run under Node 22: `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"` (or `nvm use 22`).
2. **Migrations are re‑applied in full on every `db:push`.** They MUST be idempotent
   (`create or replace`, `if not exists`, `drop policy if exists`, guarded `do $$…$$` for column drops).
   A non‑idempotent migration (e.g. dropping a column unconditionally) breaks the next push.
3. **RLS is the real security. Do NOT add manager UPDATE policies on money tables**
   (`payroll_lines`, `advances`). All manager writes go through **security‑definer RPCs**.
   Re‑adding those policies re‑opens fixed vulnerabilities (managers tampering with `net`, advance amounts, etc.).
4. **`raw_punches` is append‑only** — a trigger blocks UPDATE/DELETE for *everyone*,
   including the table owner and tests. You cannot delete punches. Namespace + leave test punches.
5. **`attendance_days` is derived** — written ONLY by `recompute_attendance` (security definer).
   Never write it from app code. It is safe to `TRUNCATE` and rebuild.
6. **No half‑day.** The model is 2‑state: present (`full_day`) if `worked_hours >= full_day_hours`, else `absent`. Do not reintroduce half‑day.
7. **UI text says "Employee"; code/DB says "worker".** The table is `workers`, columns `worker_id`,
   component `WorkerForm`, route `/workers`. When changing UI wording, change ONLY visible strings, never identifiers.
8. **`NEXT_PUBLIC_*` env vars are baked at build time.** After changing them you MUST rebuild (not just pm2 restart).
9. **Don't create new nav tabs when asked to add admin queues** — the product owner wants things folded into the existing **Approvals** tab.
10. **After any schema/RLS/engine change, run all three test suites** (`npm test`, `scripts/e2e.ts`, `scripts/e2e-features.ts`). They caught every real bug so far.

---

## 1. What this is

A **modular monolith** for a ~100‑employee warehouse: biometric attendance → monthly
payroll → salary advances, with an audit trail. One Next.js app, one Supabase database,
one auth system. Built to `requirement.md` (read it for original intent) but the product
has since evolved (see §9 "Changes since the spec").

**Stack:** Next.js 15 (App Router) · TypeScript · Tailwind v4 · Supabase (Postgres + Auth + Storage + RLS).
Plus a separate Node **gateway** for the ZKTeco devices (runs on an office PC, not the cloud).

**Roles:** `admin` (approves everything, runs payroll, sets salary/confidential data) and
`manager` (requests/proposes, disburses only their assigned groups — approves nothing).
Employees have **no login**; they punch at the device.

---

## 2. Environment & infrastructure (current, live)

- **Runtime:** Node 22 (via nvm). The machine's default `node` is v16 and will fail.
- **Supabase:** project in **Mumbai (`ap-south-1`)**, ref `cvzgnlmaqdnszroheqna`, co‑located with the
  app server (query round‑trip ~2 ms vs ~63 ms when it was in Singapore). Do NOT move it out of Mumbai.
  Credentials live in `.env.local` (git‑ignored) — never hardcode keys in committed files.
- **App host:** AWS **Lightsail** (Mumbai), Ubuntu 22.04, IP **`65.2.148.90`**.
  - Runs under **pm2** as process `warehouse-ops` (`npm start` → `next start`, port 3000).
  - **nginx** reverse‑proxies port 80 → 3000 (`client_max_body_size 10M` for uploads).
  - **2 GB swap** added so `next build` doesn't OOM on the 1 GB box.
  - App directory on server: `/home/ubuntu/app`.
  - SSH: `ssh -i ~/Downloads/LightsailDefaultKey-ap-south-1.pem ubuntu@65.2.148.90`.
  - Still **plain HTTP** (no domain/SSL yet). Don't put truly sensitive real data in until HTTPS is added.
- **Gateway:** intended to run on an **office Windows PC** on the same LAN as the ZKTeco terminals.
  Not deployed to the cloud. Has its own `gateway/.env`.
- **Cheque AI gateway (sidecar):** the S9 `llm_gatewayV9` runs on the SAME Lightsail box
  as pm2 process **`cheque-gateway`** — `uv run uvicorn main:app --host 127.0.0.1 --port 8109`
  (script `/home/ubuntu/s9/run-gateway.sh`, code `/home/ubuntu/s9/llm_gatewayV9/`, keys
  `/home/ubuntu/s9/.env`). Bound to localhost, no auth. Powers cheque field extraction
  (Gemini vision, `gemini-3.1-flash-lite`). The app calls it via `CHEQUE_GATEWAY_URL`
  (default `http://127.0.0.1:8109`). Uses **uv** (`~/.local/bin/uv`) which provisions
  Python 3.11 (box ships 3.10). Redeploy: rsync the gateway dir + `.env`, `uv sync`,
  `pm2 restart cheque-gateway`. Source of truth: `~/Desktop/projects/EAGv3/S9SharedCode/`.
- **Cheque OCR fallback (sidecar):** pm2 process **`cheque-ocr`** — a small Tesseract
  service (`POST /ocr`, `127.0.0.1:8110`) the app falls back to when Gemini is
  down/quota-exhausted, pre-filling PRINTED fields only. Repo source `ops/ocr-sidecar/`
  (`ocr_service.py` + `run-ocr.sh`); on box at `/home/ubuntu/s9-ocr/`, uv-run, needs apt
  `tesseract-ocr`. App reaches it via `CHEQUE_OCR_URL` (default `http://127.0.0.1:8110`).
  Extraction order in `extractCheque`: AI (Gemini) → local OCR → manual. Three pm2
  procs total (warehouse-ops, cheque-gateway, cheque-ocr), all `pm2 save`d.

### Deploy (the exact flow)
NEXT_PUBLIC_* are baked at build → always rebuild on the server:
```bash
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"
cd /Users/anshulagarwal/Desktop/Projects/office-tools
npx tsc --noEmit                     # must be clean
rsync -az --delete \
  -e "ssh -i ~/Downloads/LightsailDefaultKey-ap-south-1.pem -o StrictHostKeyChecking=no" \
  --exclude node_modules --exclude .next --exclude .git --exclude '.DS_Store' --exclude 'spool' \
  ./ ubuntu@65.2.148.90:/home/ubuntu/app/
ssh -i ~/Downloads/LightsailDefaultKey-ap-south-1.pem ubuntu@65.2.148.90 \
  'cd /home/ubuntu/app && npm run build && pm2 restart warehouse-ops --update-env'
```
Verify: `curl -s -o /dev/null -w "%{http_code}\n" http://65.2.148.90/` → `307` (redirects to /login when unauthenticated = correct).

### Local commands
```bash
npm install            # under Node 22 (native Tailwind oxide binary is Node-version specific)
npm run db:push        # apply supabase/migrations/*.sql in order (idempotent)
npm run db:reset       # tear down our objects then re-apply (dev only)
npm run db:seed        # create admin + manager auth users + sample data
npm run dev            # http://localhost:3000
npm test               # Vitest integration tests (need db:push + db:seed first)
```
Login (seeded): `admin@warehouse.local` / `manager@warehouse.local` (passwords in `.env.local` `SEED_*` vars).

---

## 3. Repo layout

```
supabase/migrations/   ordered SQL (0001…0014). Applied by scripts/db-push.ts.
scripts/
  db-push.ts           run migrations (re-applies ALL each time → idempotent required)
  seed.ts              create auth users (service key) + sample workers/devices
  e2e.ts               RLS + RPC flow tests (admin/manager clients + pg) — ~52 checks
  e2e-features.ts      groups / late-review / onboarding edge cases
  verify-period.ts     delayed-disbursement / period correctness check
src/
  lib/
    supabase/server.ts   RLS-bound server client (used everywhere for data)
    supabase/client.ts   browser client (login only)
    supabase/admin.ts    SERVICE-ROLE client — SERVER ONLY, bypasses RLS (e.g. create manager accounts)
    supabase/middleware.ts + middleware.ts   session refresh + /login redirect
    auth.ts              getProfile / requireProfile / requireRole
    suites.ts            navigation registry (SUITES + FEATURES) — drives home tiles + nav + guards
    storage.ts           signed URLs (cached), uploadWorkerFile, bucket constants
    notify.ts            SMS-on-disbursal hook (DEFERRED no-op; wire a provider here later)
    types.ts             shared TS types
  components/
    ui.tsx               design-system primitives (stable API): PageHeader, Card, Section,
                         Button, LinkButton, Badge, Table/Th/Td, Empty, money(), FormError/FormOk
    AppShell.tsx, SuiteNav.tsx, Tiles.tsx, WorkerAvatar.tsx (WorkerAvatar + WorkerCell)
  app/(auth)/login       login (client)
  app/(app)/             authenticated shell + all screens (home = suite tiles)
gateway/                 separate Node ADMS service for ZKTeco K40 Pro (runs on office PC)
tests/                   Vitest integration tests (helpers.ts, payroll.spec.ts, recompute.spec.ts, global-setup.ts)
docs/AGENT_CONVENTIONS.md  conventions brief used when delegating UI to sub-agents
requirement.md           original build spec (some parts now superseded — see §9)
```

---

## 4. Database & migrations

- **All business logic lives in Postgres** (security‑definer functions), not the app. The app calls RPCs.
- `scripts/db-push.ts` connects via `DATABASE_URL` and runs every `.sql` in order **on every push**.
  → Migrations must be safe to re‑run. Patterns used: `create or replace function`, `alter table … add column if not exists`,
  `drop policy if exists … create policy`, `do $$ begin … exception when duplicate_object then null; end $$;` for enums/constraints,
  and guarded column drops (see 0011's bank‑column drop wrapped in an `information_schema.columns` existence check — that was a real fix).
- **`DATABASE_URL` uses the Mumbai session pooler** (`aws-1-ap-south-1.pooler.supabase.com:5432`).
  The DB password contains `@@`, URL‑encoded as `%40%40` in the connection string.

### Migration history (what each did — read the file for detail)
| # | Purpose |
|---|---|
| 0001 | schema (all tables, types, indexes) |
| 0002 | RLS on every table, role helpers (`is_admin`/`is_manager`/`current_user_role`), `raw_punches` append‑only trigger |
| 0003 | core functions: recompute, compute, approve, decide_adjustment/advance, record_disbursal/advance_disbursal, reopen, advance‑cap trigger, closed‑period trigger, settings accessors, dedupe, `warehouse_tz`, `write_audit` |
| 0004 | seed settings + calendar (idempotent; re‑inserts on push) |
| 0005 | worker photo + id‑proof private buckets + storage RLS |
| 0006 | `raw_punches` unique index (device_serial, device_user_id, device_ts) → idempotent gateway forwarding |
| 0007 | **QA round 1:** dropped manager UPDATE policies on money tables; overlap‑period trigger; `record_disbursal` requires pay mode; advance **defer** (never negative net); approve marks advances recovered only when actually deducted |
| 0008 | add `late_review` enum value (separate file so it commits before use) |
| 0009 | **remove half‑day** (2‑state); 10 PM late hold; `late_arrival_reviews` + `decide_late_review`; recompute/compute rewrite |
| 0010 | `worker_groups`, `manager_group_access`, `can_disburse_worker`, group‑scoped payroll RLS, `record_disbursal` group check |
| 0011 | **QA round 2:** bank → admin‑only `worker_bank_details`; lone late punch → `late_review`; **group snapshot** on payroll line; defensive cutoff parse; `can_disburse_group` |
| 0012 | employee onboarding: nullable salary, `approval_status`, `worker_edit_requests`, staff storage‑insert, RPCs (`request_new_worker`, `request_worker_edit`, `approve_new_worker`, `reject_new_worker`, `decide_worker_edit`) |
| 0013 | `set_worker_media` RPC (manager persists uploaded photo/id path for a pending worker) |
| 0014 | payroll period = **calendar month**; removed obsolete `payroll_period_*_day` settings |
| 0015 | **Cheque Reconciliation:** `cheque_status` enum, `company_bank_accounts`, `cheques` (no image — extract-and-forget; dealer_name free text); RLS (all staff read, admin all, managers write via RPC); RPCs `create_cheque`/`update_cheque_draft`/`submit_cheque`/`decide_cheque`/`record_cheque_presented`/`mark_cheque_outcome`. Lifecycle draft→pending→(rejected→draft)→submitted→presented→passed\|bounced |
| 0016 | cheque `received_date` (dealer-handover date, separate from upload); folded into `apply_cheque_fields` |
| 0017 | employee code **auto-assigned** (`employee_code_seq` + `next_employee_code()` + column default `EMP-####`); `device_user_id` made **nullable** (optional PIN); `request_new_worker` rewritten (auto code, device optional, phone+group required). App: create forms hide code, drop device-required, require phone+group |
| 0018 | manager may **propose ANY group** when adding an employee (`request_new_worker` drops the `can_disburse_group` restriction — pending admin approval anyway). App: manager add + edit **group dropdowns list all groups**; the edit **guard** (which workers a manager may edit) stays scoped to own groups |
| 0019 | `decide_worker_edit`: `device_user_id` uses present-key/empty→NULL semantics (manager edits now submit ONLY changed fields) |
| 0020 | `set_worker_media`: a manager may set photo/id-proof for any worker **in their group** (not just pending ones they created) |
| 0021 | `company_bank_accounts.payee` — links our bank account to a payee company (Anmol Associates / Om Marketing) so cheque presentation auto-fills the account |
| 0022 | **`profiles.full_access`** (bool, default **false**) — per-user gate. Admins always full (role check). Managers with `full_access=true` see all suites; managers **without** it see **HR & Payroll as "coming soon"** (Cheque-only). New managers default to false. Logic: `GATED_SUITES` + `suiteComingSoon()` in `src/lib/suites.ts`; route guard `requireSuiteAccess()` in `src/lib/auth.ts` |
| 0023 | **UPI Reconciliation** (admin suite `upi`): `upi_mappings` (upi_id→dealer_name, admin RLS). Tab 1 `/upi` maps dealer VPAs; tab 2 `/upi/reconcile` parses an HDFC .xls **client-side** (SheetJS `xlsx` from CDN tarball, dynamic import) and labels each UPI txn by dealer. VPA parsed from narration via `extractVpa` in `src/lib/upi.ts`. Nothing uploaded/stored — report only |

### Tables (key ones)
`profiles` (id=auth.users, role) · `settings` (jsonb) · `workers` (has `approval_status`, `group_id`, nullable
`monthly_salary`, `photo_path`, `id_proof_path`; **no bank columns**) · `worker_bank_details` (admin‑only) ·
`worker_groups` · `manager_group_access` (manager_id, group_id) · `worker_edit_requests` (pending edits) ·
`devices` · `raw_punches` (append‑only) · `work_calendar` (day_type) · `attendance_days` (derived) ·
`adjustments` · `advances` · `payroll_runs` · `payroll_lines` (has `group_id_snapshot`, `salary_snapshot`) ·
`payroll_line_components` (earning/deduction rows; `net = sum`) · `late_arrival_reviews` · `audit_log`.

---

## 5. Security model (RLS + RPCs) — the invariants

- **RLS is the gate; route guards are cosmetic.** Assume any authenticated user can hit the REST API directly.
- **Security‑definer guard pattern:** `if auth.uid() is not null and not is_admin() then raise …`.
  Meaning: an authenticated non‑admin is blocked, but a **no‑auth caller (service key / gateway / cron / direct pg in tests) is trusted system context** and allowed. Keep this pattern for admin RPCs.
- **Managers cannot directly write** `workers`, `settings`, `work_calendar`, `payroll_lines`, `advances`,
  `worker_groups`, `manager_group_access`, `worker_bank_details`. Every manager write goes through an RPC.
  (This is why bugs #2–5,8 were fixed by *removing* policies — do not add them back.)
- **Money‑table writes only via RPC:** `record_disbursal`, `record_advance_disbursal`. These are
  security‑definer (run as owner → bypass RLS) so managers don't need table UPDATE.
- **Bank details are admin‑only** (`worker_bank_details` has only an admin policy). Never put bank on `workers`.
- **Group scoping for disbursal:** a manager may disburse a payroll line only if
  `can_disburse_group(payroll_lines.group_id_snapshot)`. **Scope by the SNAPSHOT captured at compute time,
  not the live `workers.group_id`** — otherwise moving an employee between groups retroactively changes who can
  disburse an already‑approved run (that was a real bug). Ungrouped/other groups → admin‑only.
- **Salary is visible to managers** on the `workers` table (needed for the advance‑cap display). This is an
  accepted trade‑off; bank/phone‑level PII is what's protected. (Open question: whether to fully scope salary — see §10.)
- **RPC catalog** (all `public`, security definer unless noted):
  - Attendance/payroll: `recompute_attendance(from,to)`, `compute_payroll_run(run)`, `approve_payroll_run(run)`,
    `reopen_payroll_run(run,reason)`, `record_disbursal(line,mode,ref)`.
  - Decisions: `decide_adjustment(id,approve,reason)`, `decide_advance(id,approve,reason)`,
    `decide_late_review(worker,day,approve,reason)`, `record_advance_disbursal(id)`.
  - Onboarding: `request_new_worker(jsonb)→uuid`, `request_worker_edit(worker,jsonb)→uuid`,
    `approve_new_worker(worker,salary,bank_account,bank_ifsc)`, `reject_new_worker(worker,reason)`,
    `decide_worker_edit(id,approve,reason)`, `set_worker_media(worker,photo_path,id_proof_path)`.
  - Helpers: `is_admin`, `is_manager`, `current_user_role`, `can_disburse_worker`, `can_disburse_group`,
    `setting_num/bool/text`, `warehouse_tz`, `dedupe_punch_times`, `write_audit`.

---

## 6. Payroll / attendance engine — the exact rules

These are money rules. Do not "improve" them without explicit instruction. Verified by 24 Vitest tests.

- **Timezone:** store everything UTC. Calendar‑day boundaries use the **warehouse timezone**
  (`warehouse_timezone` setting, default `Asia/Kolkata`). Punches keep both `device_ts` and `server_ts`;
  their divergence beyond `clock_drift_alert_minutes` is the clock‑drift canary.
- **Dedupe:** punches within `dedupe_window_minutes` (default 2), across any device, collapse to one event.
- **2‑state classification** (`recompute_attendance`): present (`full_day`) if
  `worked_hours >= full_day_hours` (7) else `absent`. **No half‑day.** Clock‑to‑clock: first punch = IN, last = OUT.
  Ignore the device IN/OUT flag; pair chronologically.
  - 0 punches on a working day → `absent`. 1 punch (not late) → `unresolved` (dangling; blocks payroll).
  - Closed calendar day → `not_working_day`.
- **10 PM rule:** if the day's **first punch** is after `late_first_punch_cutoff` (default `22:00`, warehouse tz) →
  status `late_review` (held, blocks payroll). A **lone** late punch is also `late_review`. Admin resolves via
  `decide_late_review`: approve → `full_day` (present), reject → `absent`. The cutoff parse is **defensive**
  (a bad setting value falls back to 22:00 instead of breaking recompute) and the Settings save validates it.
- **Payroll period = full calendar month** (1st → last day). The engine computes over each run's stored
  `period_start`/`period_end`, so it is correct for any period. New‑run form defaults to the **previous calendar
  month**; pay date defaults to the **2nd Saturday of the current month** (admin‑editable; disbursal is manual).
- **`compute_payroll_run` guards:** refuses to run if the period has any `unresolved` OR `late_review` day,
  or any `pending` adjustment. Only `draft` runs compute; recomputable freely while draft.
- **Money math:** `daily_rate = monthly_salary / daily_rate_divisor` (**always /30**, regardless of month length).
  `leave_units = absent_days` (working + swapped_working days only; extra_working excluded). Deduction is
  **0 if `leave_units <= free_leave_units` (1), else `leave_units × daily_rate`** — the whole amount, retroactively
  (the "cliff" is intentional client policy). `extra_days` = full_day on `extra_working` days → `extra_days × daily_rate`
  extra pay; absence on an extra_working day is NOT a leave. **No overtime.**
- **Advance recovery:** full outstanding recovered from the run. **Defer the whole advance** to a later run if it
  can't fit (so **net is never negative**). `approve_payroll_run` marks an advance recovered ONLY if it was
  disbursed on/before `computed_at` AND the line's `advance_recovery` component > 0. Advance **cap** (trigger):
  `outstanding + requested <= salary × advance_cap_multiple` (blocks the request).
- **`net = sum(earnings) − sum(deductions)`** from `payroll_line_components` (extensible → PF/ESI later, no migration).
- **Run lifecycle:** `draft → admin_approved → disbursing → closed`. Figures freeze at `admin_approved`.
  Reopen (admin, loud/audited) only if no line is paid; releases recovered advances. Run auto‑closes when all lines paid.
- **Overlapping payroll periods are rejected** (trigger); duplicate periods rejected (unique index).

---

## 7. Employee onboarding & approvals flow (recent, important)

- **Managers add employees** (their groups only) via `request_new_worker(jsonb)` → creates a **pending, inactive,
  null‑salary** worker (fields: employee_code, full_name, device_user_id, group_id, phone, joined_on; **no salary/bank**).
  Then the client uploads photo/id and calls `set_worker_media` (managers can't UPDATE `workers` directly).
- **Managers propose edits** to their group's employees via `request_worker_edit` → a row in `worker_edit_requests`.
  The live worker is **unchanged until an admin approves**.
- **Admin approves in the Approvals tab** (no separate tab): "New employee requests" (admin enters salary + bank,
  `approve_new_worker`, or `reject_new_worker`) and "Employee changes" (diff view, `decide_worker_edit`).
- **Pending workers are `is_active=false`** → excluded from attendance/payroll. Their punches still resolve to their
  PIN (the gateway resolves against all workers), so after approval you can recompute to backfill attendance.
- Managers **cannot** set salary/bank, approve anything, touch groups outside their own, or read bank details.

---

## 8. Navigation, UI conventions, storage

- **Two‑level IA in `src/lib/suites.ts`:** `SUITES` (HR System, Payroll, Cheque Reconciliation [coming‑soon])
  and `FEATURES` (role‑filtered). Home = suite tiles → land on the suite's **first feature (tab)**. Adding a feature =
  edit this file (title/description are display text; `key`/`href`/`roles`/`suites` are structural).
  **Product owner preference: fold new admin queues into existing tabs (Approvals), don't add new tabs.**
- **Data flow:** Server Components read via `createSupabaseServerClient()` (RLS applies). Mutations via
  **server actions** (`"use server"`) + `revalidatePath`. Guard pages with `requireRole(...)`.
  Managers may need a role‑aware page (e.g. `/workers` branches admin vs manager).
- **Primitives:** import from `@/components/ui`. Keep their API stable. Money via `money()` + `className="tabular"`.
  Tailwind v4 with CSS tokens (`--color-ink`, `--color-brand`, etc.) — keep token names.
  Dense/plain internal‑tool aesthetic. Modals: see `WorkerSummaryButton` / `LineBreakdownButton` (click‑to‑open,
  batch‑signed data passed in) — the pattern to reuse instead of inline‑expanding rows (which bloat with 100+ rows).
- **Storage / egress (photos are the only real egress driver):** photos in a private bucket served via **signed URLs**
  (server‑cached, long TTL, long `cacheControl`); id‑proofs admin‑only. **Resize photos in the browser before upload**
  (`resizeImage` in `WorkerForm.tsx`) → ~30 KB thumbnails. Avatars `loading="lazy"`; Workers list paginates.
  Managers can UPLOAD to both buckets (staff insert policy) but cannot READ id‑proofs. Use `signedPhotoUrlMap` (batch).

---

## 9. Changes since `requirement.md` (spec is partly superseded)

- **Half‑day removed** → 2‑state present/absent (spec §3.1 changed).
- **Payroll period = calendar month** (spec said 10th→9th; now 1st→last, pay = 2nd Saturday next month, manual).
- **Employee groups + per‑manager disbursal scope**; managers can add employees / propose edits with admin approval.
- **Bank details** moved to admin‑only `worker_bank_details`.
- **10 PM late‑review** hold added.
- **UI term "Worker" → "Employee"** (identifiers unchanged).
- **Gateway** built (not part of original scope) in `gateway/`. **Cheque Reconciliation** is a coming‑soon placeholder tile.

---

## 10. Known open items / decisions (don't silently "fix")

- **Advance cash‑handover (`record_advance_disbursal`) is NOT group‑scoped** like salary disbursal is. Any manager can
  record any advance's handover. Flagged; awaiting a product decision to scope it or leave it.
- **Salary is readable by all managers** via `workers` (kept for the advance‑cap UI). Fully scoping it would need a
  view/refactor and touches the (unscoped) advances flow — needs a decision.
- **Salary/employee edits by the admin are not written to `audit_log`** (workers table edits bypass the audited RPCs).
  Adding an old→new audit trail (optionally a required reason) is a suggested improvement.
- **URL is still `/workers`** even though the UI says "Employees" (kept internal; can be changed if wanted).
- **HTTP only** (no domain/SSL). Add Let's Encrypt once a domain exists before real payroll data.
- **SMS on disbursal** is a deferred no‑op stub in `src/lib/notify.ts` (needs a provider + India DLT).
- Some **code comments** still say "worker" — harmless, internal.

---

## 11. Testing (run these; they find the bugs)

Three harnesses, all against the **live DB** (integration; the logic is in SQL). Require `db:push` + `db:seed` first
(so a `profiles` row exists). Run under Node 22.

- **`npm test`** (Vitest, `tests/*.spec.ts`) — 24 tests: payroll acceptance + recompute (2‑state, late, dedupe,
  idempotency, guards). Serial (`fileParallelism:false`, single fork); `tests/global-setup.ts` wipes far‑future test data.
- **`npx tsx scripts/e2e.ts`** — RLS + RPC flows as real admin/manager Supabase clients (~52 checks): advance→approve→recovery,
  cap, cliff, disbursal lifecycle, reopen, RLS/privilege boundaries, append‑only, etc.
- **`npx tsx scripts/e2e-features.ts`** — groups/late‑review/onboarding edge cases (~40+ checks).

**Test‑data hygiene (important):**
- Namespace: `TEST-*` (vitest), `E2E-*` (e2e), `FT-*` (features). Far‑future years (2055–2099) so they never collide with real data.
- **Unique IDs:** `raw_punches` is append‑only and its dedupe index is `(device_serial, device_user_id, device_ts)`, so
  re‑runs must use **time‑based unique `device_user_id`** (see `RUNBASE`/`nextUid` in the scripts). Workers pinned by
  punches can't be deleted — they're only deactivated on cleanup.
- Wipes clear far‑future `payroll_runs`, `work_calendar` (a stray test `extra_working` day will corrupt another test's pay!),
  groups, and `*-%` workers without punches. Match this pattern for new test data.
- Tests create workers via direct `pg` insert (bypasses RLS as owner). Money‑flow tests use RPCs via signed‑in clients.

**Judgment when "bugs" appear in a re‑run:** several past "failures" were **test‑harness artifacts** (leftover data,
grant timing after a snapshot change, exact‑count assertions on a shared DB). Diagnose whether it's a product bug or the
harness before "fixing" the product.

---

## 12. The gateway (`gateway/`) — device integration

- Small Node service (Express, no build step) that runs on an **office Windows PC on the device LAN**. Not cloud‑deployed.
- Implements ADMS/PUSH endpoints (`/iclock/cdata`, `/iclock/getrequest`, `/iclock/devicecmd`); TSV payloads, not JSON.
- **Store‑and‑forward:** durable spool directory (`gateway/spool/`), retries to Supabase with backoff, never drops a punch.
- Resolves `worker_id` by `device_user_id` (all workers, incl. pending), inserts `raw_punches` idempotently
  (upsert on the dedupe index), updates `devices` heartbeat/drift, then calls `recompute_attendance` for affected days.
- Device time is naive local; the gateway attaches `DEVICE_TZ_OFFSET` (`+05:30`) to make it an instant.
- Own `gateway/.env` with `SUPABASE_URL` + service key (points at the Mumbai project).

---

## 13. Working style that fits this repo

- **Ask, don't assume** on money/security/product decisions (the owner has repeatedly wanted specific behavior).
- Prefer **DB‑level enforcement** (RLS/RPC/trigger) over UI‑only guards.
- For big UI work, delegating to parallel sub‑agents works — give each precise file scope, the exact RPC signatures,
  and "don't touch shared files." Always **full‑tree `tsc` + `next build`** after they land.
- Keep migrations idempotent; keep the three test suites green; rebuild (not just restart) after env changes;
  rename UI text without touching identifiers; fold admin queues into Approvals; never re‑open the money‑table RLS.
```

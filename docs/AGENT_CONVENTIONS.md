# Build conventions — READ FIRST, follow exactly

This is a Next.js 15 (App Router) + TypeScript + Tailwind v4 + Supabase app. A
foundation already exists. Your job is to build specific screens **consistently**
with it. Do NOT modify shared files — only read them: `src/lib/*`,
`src/components/ui.tsx`, `src/components/AppShell.tsx`, `supabase/migrations/*`.

## Where pages go

All authenticated pages live under `src/app/(app)/<route>/page.tsx`. The `(app)`
layout already renders the shell + nav and calls `requireProfile()`. The route
group does not change the URL — `(app)/workers/page.tsx` serves `/workers`.

## Auth / role guard (top of every page)

```ts
import { requireRole } from "@/lib/auth";
export default async function Page() {
  const profile = await requireRole("admin");   // or "manager", or ("admin","manager")
  // ...
}
```

RLS in the database is the real gate. `requireRole` is the cosmetic UI guard;
still include it so users don't land on unusable screens.

## Data access

Server Components read data directly. Mutations go through **server actions**.

```ts
import { createSupabaseServerClient } from "@/lib/supabase/server";
const supabase = await createSupabaseServerClient();
const { data, error } = await supabase.from("workers").select("*").order("employee_code");
```

Server action pattern (own file `actions.ts` next to the page, `"use server"`):

```ts
"use server";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function createWorker(formData: FormData) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("workers").insert({
    employee_code: String(formData.get("employee_code")),
    // ...
  });
  if (error) return { error: error.message };
  revalidatePath("/workers");
  return { ok: true };
}
```

For forms that must show inline success/error, make a small `"use client"`
component that calls the action and renders `<FormError>` / `<FormOk>`. For
simple fire-and-revalidate buttons, a plain `<form action={serverAction}>` with
a hidden input for the id is fine.

Call RPCs with `supabase.rpc("name", { p_arg: value })`. RPC errors come back as
`{ error }`; surface `error.message` verbatim (the SQL raises human-readable
messages we want the user to see, e.g. the advance-cap block).

## UI primitives — import from `@/components/ui`

`PageHeader`, `Card`, `Section`, `Button`, `LinkButton`, `Badge`, `Table`, `Th`,
`Td`, `Empty`, `money(n)`, `FormError`, `FormOk`.

- `<Table head={<tr><Th>...</Th></tr>}>` then `<tr><Td>...</Td></tr>` rows.
- `Button` variants: `primary | default | danger | ghost`. Use `type="submit"`.
- Money: always `money(value)` and add `className="tabular"` on numeric cells.
- Inputs (no component — use this exact class):
  `className="mt-1 w-full rounded border border-line px-3 py-2 text-sm"`
- `Badge` tones: `neutral | ok | warn | danger | info`.

Keep it **plain and dense**. Internal tool for two people. No hero sections.

## Money & dates

- All money is `numeric` → comes back as string; wrap with `money()`.
- Dates are `date`/`timestamptz`. Show dates as `YYYY-MM-DD`. Use
  `new Date(x).toLocaleString("en-IN")` for timestamps.

## RPC signatures (Postgres, call via supabase.rpc)

| RPC | Args | Who | Effect |
|---|---|---|---|
| `recompute_attendance` | `{ from_date, to_date }` (dates 'YYYY-MM-DD') | admin | rebuilds attendance_days |
| `compute_payroll_run` | `{ p_run_id }` | admin | (re)computes draft run lines |
| `approve_payroll_run` | `{ p_run_id }` | admin | freezes figures → admin_approved |
| `reopen_payroll_run` | `{ p_run_id, p_reason }` | admin | admin_approved → draft (needs reason) |
| `record_disbursal` | `{ p_line_id, p_mode, p_reference }` p_mode 'cash'\|'online' | manager | marks a line paid |
| `decide_adjustment` | `{ p_id, p_approve, p_reason }` | admin | approve/reject; approve recomputes the day |
| `decide_advance` | `{ p_id, p_approve, p_reason }` | admin | approve/reject |
| `record_advance_disbursal` | `{ p_id }` | manager | sets disbursed_at |

Rejections require a non-empty reason (SQL enforces; also validate in UI).

## Table/column reference (key columns only)

- `workers`: id, employee_code, full_name, device_user_id (int, unique PIN),
  monthly_salary, bank_account, bank_ifsc, joined_on, left_on, is_active
- `devices`: serial_number (pk), label, last_seen_at, last_device_time, is_active
- `raw_punches`: id, device_serial, device_user_id, worker_id, device_ts,
  server_ts, verify_mode, raw_line — **read-only** (append-only table)
- `work_calendar`: day (pk, date), day_type ('working'|'closed'|'extra_working'|
  'swapped_working'), note, updated_by, updated_at
- `attendance_days`: worker_id, day, first_in, last_out, worked_hours, status
  ('full_day'|'half_day'|'absent'|'unresolved'|'not_working_day'),
  is_from_adjustment — **read-only** from app (written only by recompute)
- `adjustments`: id, worker_id, day, proposed_in, proposed_out, reason, status,
  requested_by, requested_at, decided_by, decided_at, decision_reason
- `advances`: id, worker_id, amount, reason, status, requested_by, requested_at,
  decided_by, decided_at, decision_reason, disbursed_at, recovered_in_run
- `payroll_runs`: id, period_start, period_end, pay_date, status
  ('draft'|'admin_approved'|'disbursing'|'closed'), computed_at, approved_at, closed_at
- `payroll_lines`: id, run_id, worker_id, salary_snapshot, daily_rate_snapshot,
  full_days, half_days, absent_days, extra_days, leave_units, net, pay_mode,
  paid_at, paid_by, payment_reference
- `payroll_line_components`: id, line_id, code, label, type ('earning'|'deduction'), amount
- `settings`: key (pk), value (jsonb), description
- `audit_log`: id, actor_id, action, entity_table, entity_id, before_value,
  after_value, reason, created_at
- `profiles`: id, full_name, role

## RLS constraints you must respect in the UI

- Managers can INSERT adjustments/advances (status stays 'pending') but can NOT
  decide them — decisions are admin-only RPCs.
- Managers see payroll_runs/lines only once status is `admin_approved`+.
- Managers update payroll_lines payment fields only via `record_disbursal`.
- Only admins write workers, settings, work_calendar.
- Never write to `raw_punches` or `attendance_days` from the app.

## Business rules that affect these screens (spec §3)

- Advance request is **blocked** (SQL raises) if outstanding + amount > salary ×
  advance_cap_multiple. Show the outstanding balance next to the form and surface
  the block error.
- Marking a day `extra_working` costs a day's pay per worker — **warn loudly**
  (confirm dialog / red note) in the calendar UI.
- Payroll **cannot compute** while unresolved days or pending adjustments exist
  in the period — the RPC raises; show the message and an exceptions list.
- Rejections (adjustment/advance) require a reason.

## Outstanding balance query (reuse where needed)

Outstanding for a worker = approved + disbursed + not-yet-recovered advances:
```ts
supabase.from("advances").select("amount")
  .eq("worker_id", id).eq("status","approved")
  .not("disbursed_at","is",null).is("recovered_in_run",null)
```
Sum the amounts.

## Do not

- Do not add new npm dependencies.
- Do not build anything from spec §10 (no OT, no leave types, no worker portal).
- Do not touch the gateway (out of scope for this build).
- Do not edit shared files listed at the top.

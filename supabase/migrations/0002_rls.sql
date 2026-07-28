-- ============================================================================
-- 0002_rls.sql — Row Level Security (spec §5)
-- RLS is the real permission system. Route guards are cosmetic.
-- The manager can REQUEST but never APPROVE. Every pay-changing path goes
-- through the admin, enforced here.
-- ============================================================================

-- ── Role helpers ────────────────────────────────────────────────────────────
-- security definer so they can read profiles without tripping RLS recursion.

create or replace function public.current_user_role()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_user_role() = 'admin', false);
$$;

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_user_role() = 'manager', false);
$$;

-- ── raw_punches: append-only. Belt and braces (spec §5, §0 invariant 1) ──────
create or replace function public.forbid_punch_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'raw_punches is append-only: % is forbidden', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists raw_punches_no_update on raw_punches;
create trigger raw_punches_no_update
  before update on raw_punches
  for each row execute function public.forbid_punch_mutation();

drop trigger if exists raw_punches_no_delete on raw_punches;
create trigger raw_punches_no_delete
  before delete on raw_punches
  for each row execute function public.forbid_punch_mutation();

-- ── Enable RLS on every table ────────────────────────────────────────────────
alter table profiles                enable row level security;
alter table settings                enable row level security;
alter table workers                 enable row level security;
alter table devices                 enable row level security;
alter table raw_punches             enable row level security;
alter table work_calendar           enable row level security;
alter table attendance_days         enable row level security;
alter table adjustments             enable row level security;
alter table advances                enable row level security;
alter table payroll_runs            enable row level security;
alter table payroll_lines           enable row level security;
alter table payroll_line_components enable row level security;
alter table audit_log               enable row level security;

-- ── profiles ─────────────────────────────────────────────────────────────────
-- Everyone authenticated may read profiles (needed to render names). Nobody
-- edits roles from the app; that is a seed/admin-SQL concern.
drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles
  for select using (auth.uid() is not null);

-- ── settings: admin ALL, manager SELECT ──────────────────────────────────────
drop policy if exists settings_select on settings;
create policy settings_select on settings
  for select using (auth.uid() is not null);

drop policy if exists settings_admin_write on settings;
create policy settings_admin_write on settings
  for all using (public.is_admin()) with check (public.is_admin());

-- ── workers: admin ALL, manager SELECT ───────────────────────────────────────
drop policy if exists workers_select on workers;
create policy workers_select on workers
  for select using (auth.uid() is not null);

drop policy if exists workers_admin_write on workers;
create policy workers_admin_write on workers
  for all using (public.is_admin()) with check (public.is_admin());

-- ── devices: admin ALL, manager SELECT ───────────────────────────────────────
drop policy if exists devices_select on devices;
create policy devices_select on devices
  for select using (auth.uid() is not null);

drop policy if exists devices_admin_write on devices;
create policy devices_admin_write on devices
  for all using (public.is_admin()) with check (public.is_admin());

-- ── raw_punches: SELECT only for both roles ──────────────────────────────────
-- INSERT happens through the gateway using the service_role key, which bypasses
-- RLS. UPDATE/DELETE are additionally blocked by the trigger above.
drop policy if exists raw_punches_select on raw_punches;
create policy raw_punches_select on raw_punches
  for select using (auth.uid() is not null);

-- ── work_calendar: admin ALL, manager SELECT ─────────────────────────────────
drop policy if exists work_calendar_select on work_calendar;
create policy work_calendar_select on work_calendar
  for select using (auth.uid() is not null);

drop policy if exists work_calendar_admin_write on work_calendar;
create policy work_calendar_admin_write on work_calendar
  for all using (public.is_admin()) with check (public.is_admin());

-- ── attendance_days: SELECT only. Written ONLY by recompute (security definer) ─
drop policy if exists attendance_days_select on attendance_days;
create policy attendance_days_select on attendance_days
  for select using (auth.uid() is not null);
-- No INSERT/UPDATE/DELETE policy for any role → only security-definer functions write.

-- ── adjustments ──────────────────────────────────────────────────────────────
-- admin: SELECT + UPDATE (decide). manager: SELECT + INSERT (request).
-- The manager must NOT be able to set status. Enforced by:
--   (a) INSERT check pins status='pending' and requested_by=self
--   (b) no UPDATE policy for manager → decisions go through admin RPC / policy
drop policy if exists adjustments_select on adjustments;
create policy adjustments_select on adjustments
  for select using (auth.uid() is not null);

drop policy if exists adjustments_manager_insert on adjustments;
create policy adjustments_manager_insert on adjustments
  for insert with check (
    public.is_manager()
    and requested_by = auth.uid()
    and status = 'pending'
    and decided_by is null
    and decided_at is null
  );

drop policy if exists adjustments_admin_update on adjustments;
create policy adjustments_admin_update on adjustments
  for update using (public.is_admin()) with check (public.is_admin());

-- ── advances ─────────────────────────────────────────────────────────────────
-- admin: SELECT + UPDATE (decide). manager: SELECT + INSERT + UPDATE (disbursed_at only).
drop policy if exists advances_select on advances;
create policy advances_select on advances
  for select using (auth.uid() is not null);

drop policy if exists advances_manager_insert on advances;
create policy advances_manager_insert on advances
  for insert with check (
    public.is_manager()
    and requested_by = auth.uid()
    and status = 'pending'
    and decided_by is null
  );

drop policy if exists advances_admin_update on advances;
create policy advances_admin_update on advances
  for update using (public.is_admin()) with check (public.is_admin());

-- Manager may set disbursed_at only, and only on already-approved advances.
-- The column-level guarantee (only disbursed_at changes) is enforced by the
-- record_advance_disbursal RPC in 0003; this policy is the RLS backstop that
-- lets the manager touch the row at all.
drop policy if exists advances_manager_disburse on advances;
create policy advances_manager_disburse on advances
  for update using (public.is_manager() and status = 'approved')
  with check (public.is_manager() and status = 'approved');

-- ── payroll_runs: admin ALL, manager SELECT (only admin_approved+) ────────────
drop policy if exists payroll_runs_admin_all on payroll_runs;
create policy payroll_runs_admin_all on payroll_runs
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists payroll_runs_manager_select on payroll_runs;
create policy payroll_runs_manager_select on payroll_runs
  for select using (
    public.is_manager()
    and status in ('admin_approved', 'disbursing', 'closed')
  );

-- ── payroll_lines: admin ALL, manager SELECT + UPDATE (payment fields only) ───
drop policy if exists payroll_lines_admin_all on payroll_lines;
create policy payroll_lines_admin_all on payroll_lines
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists payroll_lines_manager_select on payroll_lines;
create policy payroll_lines_manager_select on payroll_lines
  for select using (
    public.is_manager()
    and exists (
      select 1 from payroll_runs r
      where r.id = payroll_lines.run_id
        and r.status in ('admin_approved', 'disbursing', 'closed')
    )
  );

-- Manager may update payment fields only. The "figures unchanged" guarantee is
-- enforced by the record_disbursal RPC (0003); this is the RLS backstop.
drop policy if exists payroll_lines_manager_pay on payroll_lines;
create policy payroll_lines_manager_pay on payroll_lines
  for update using (
    public.is_manager()
    and exists (
      select 1 from payroll_runs r
      where r.id = payroll_lines.run_id
        and r.status in ('admin_approved', 'disbursing')
    )
  ) with check (public.is_manager());

-- ── payroll_line_components: admin ALL, manager SELECT (visible runs only) ────
drop policy if exists plc_admin_all on payroll_line_components;
create policy plc_admin_all on payroll_line_components
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists plc_manager_select on payroll_line_components;
create policy plc_manager_select on payroll_line_components
  for select using (
    public.is_manager()
    and exists (
      select 1
      from payroll_lines l
      join payroll_runs r on r.id = l.run_id
      where l.id = payroll_line_components.line_id
        and r.status in ('admin_approved', 'disbursing', 'closed')
    )
  );

-- ── audit_log: admin SELECT only, manager none ───────────────────────────────
-- Writes happen via security-definer functions / service role only.
drop policy if exists audit_log_admin_select on audit_log;
create policy audit_log_admin_select on audit_log
  for select using (public.is_admin());

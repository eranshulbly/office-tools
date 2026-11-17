-- ============================================================================
-- 0010_worker_groups.sql — worker groups + per-manager disbursal scope.
-- A worker belongs to one group. Admin assigns which groups each manager may
-- disburse. Managers see/disburse salary only for workers in their groups;
-- ungrouped workers and all other groups are admin-only. (Scope: salary/disburse
-- only — attendance/adjustments/advances stay unscoped for managers.)
-- ============================================================================

create table if not exists worker_groups (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  created_at timestamptz default now()
);

alter table workers add column if not exists group_id uuid references worker_groups(id);
create index if not exists workers_group_idx on workers (group_id);

create table if not exists manager_group_access (
  manager_id uuid not null references profiles(id) on delete cascade,
  group_id uuid not null references worker_groups(id) on delete cascade,
  primary key (manager_id, group_id)
);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table worker_groups enable row level security;
drop policy if exists wg_select on worker_groups;
create policy wg_select on worker_groups for select using (auth.uid() is not null);
drop policy if exists wg_admin_all on worker_groups;
create policy wg_admin_all on worker_groups for all using (public.is_admin()) with check (public.is_admin());

alter table manager_group_access enable row level security;
drop policy if exists mga_admin_all on manager_group_access;
create policy mga_admin_all on manager_group_access for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists mga_manager_select on manager_group_access;
create policy mga_manager_select on manager_group_access for select using (manager_id = auth.uid());

-- ── Access helper ────────────────────────────────────────────────────────────
-- Admin may disburse anyone; a manager only workers in their assigned groups.
create or replace function public.can_disburse_worker(p_worker uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or exists (
        select 1 from workers w
        join manager_group_access mga on mga.group_id = w.group_id
        where w.id = p_worker and mga.manager_id = auth.uid()
      );
$$;
grant execute on function public.can_disburse_worker(uuid) to authenticated;

-- ── Scope managers' payroll visibility to their groups ───────────────────────
drop policy if exists payroll_lines_manager_select on payroll_lines;
create policy payroll_lines_manager_select on payroll_lines
  for select using (
    public.is_manager()
    and exists (
      select 1 from payroll_runs r
      where r.id = payroll_lines.run_id
        and r.status in ('admin_approved', 'disbursing', 'closed')
    )
    and public.can_disburse_worker(payroll_lines.worker_id)
  );

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
        and public.can_disburse_worker(l.worker_id)
    )
  );

-- ── record_disbursal — enforce the manager's group scope ─────────────────────
create or replace function public.record_disbursal(p_line_id uuid, p_mode pay_mode, p_reference text)
returns void language plpgsql security definer set search_path = public as $$
declare
  line payroll_lines%rowtype;
  run payroll_runs%rowtype;
  v_unpaid int;
begin
  if auth.uid() is not null and not (public.is_manager() or public.is_admin()) then
    raise exception 'record_disbursal: manager or admin only' using errcode = 'insufficient_privilege';
  end if;
  if p_mode is null then
    raise exception 'a pay mode (cash or online) is required';
  end if;

  select * into line from payroll_lines where id = p_line_id for update;
  if line.id is null then raise exception 'payroll line % not found', p_line_id; end if;
  if line.paid_at is not null then raise exception 'line % is already paid', p_line_id; end if;

  -- Group scope: a manager may only disburse workers in their assigned groups.
  if auth.uid() is not null and public.is_manager() and not public.is_admin()
     and not public.can_disburse_worker(line.worker_id) then
    raise exception 'you are not allowed to disburse this worker''s group'
      using errcode = 'insufficient_privilege';
  end if;

  select * into run from payroll_runs where id = line.run_id for update;
  if run.status not in ('admin_approved', 'disbursing') then
    raise exception 'run is % — disbursal not allowed', run.status;
  end if;

  update payroll_lines
  set pay_mode = p_mode, paid_at = now(), paid_by = auth.uid(), payment_reference = p_reference
  where id = p_line_id;

  if run.status = 'admin_approved' then
    update payroll_runs set status = 'disbursing' where id = run.id;
  end if;

  select count(*) into v_unpaid from payroll_lines where run_id = run.id and paid_at is null;
  if v_unpaid = 0 then
    update payroll_runs set status = 'closed', closed_at = now() where id = run.id;
  end if;

  perform public.write_audit('payroll_line_paid', 'payroll_lines', p_line_id::text, null,
    jsonb_build_object('pay_mode', p_mode, 'reference', p_reference), null);
end;
$$;

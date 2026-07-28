-- ============================================================================
-- 0007_qa_fixes.sql — fixes for issues found by the end-to-end QA harness.
--   #1  approve marked advances recovered even when not actually deducted
--   #2-#5,#8  manager could write payroll_lines / advances directly via REST,
--             bypassing the controlled RPCs (tamper figures, change advance
--             amount, clear recovery flag, mark paid outside the disbursal flow)
--   #7  net could go negative (full-salary advance + leave deduction)
--   #9  overlapping payroll periods allowed → double payment
--   #10 disbursal accepted a null pay mode
--  (#6 — payroll on an uncomputed period — is fixed in the app: the Compute
--   action now runs recompute for the period first.)
-- ============================================================================

-- ── #2–#5, #8: remove managers' direct UPDATE on money tables ────────────────
-- The security-definer RPCs (record_disbursal, record_advance_disbursal) run as
-- the table owner and bypass RLS, so they still work. Without these policies a
-- manager's direct REST UPDATE matches no policy and is denied — every write now
-- goes through the controlled, audited RPCs. Managers keep SELECT.
drop policy if exists payroll_lines_manager_pay on payroll_lines;
drop policy if exists advances_manager_disburse on advances;

-- ── #9: reject overlapping payroll periods ───────────────────────────────────
create or replace function public.guard_run_period_overlap()
returns trigger language plpgsql set search_path = public as $$
begin
  if exists (
    select 1 from payroll_runs r
    where r.id <> new.id
      and new.period_start <= r.period_end
      and new.period_end   >= r.period_start
  ) then
    raise exception 'payroll period % to % overlaps an existing run',
      new.period_start, new.period_end using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists payroll_runs_no_overlap on payroll_runs;
create trigger payroll_runs_no_overlap
  before insert or update of period_start, period_end on payroll_runs
  for each row execute function public.guard_run_period_overlap();

-- ── #10 + #1 unchanged parts: record_disbursal requires a pay mode ───────────
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
    raise exception 'a pay mode (cash or online) is required';   -- #10
  end if;

  select * into line from payroll_lines where id = p_line_id for update;
  if line.id is null then raise exception 'payroll line % not found', p_line_id; end if;
  if line.paid_at is not null then raise exception 'line % is already paid', p_line_id; end if;

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

-- ── #7: never pay a negative net (defer the whole advance if it can't fit) ───
create or replace function public.compute_payroll_run(p_run_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  run payroll_runs%rowtype;
  v_divisor numeric := public.setting_num('daily_rate_divisor');
  v_free    numeric := public.setting_num('free_leave_units');
  w record;
  v_daily numeric;
  v_full_days int; v_half_days int; v_absent_days int; v_extra_days int;
  v_leave_units numeric; v_deduction numeric; v_extra_pay numeric;
  v_outstanding numeric; v_recovery numeric; v_available numeric;
  v_net numeric; v_line_id uuid;
  v_unresolved int; v_pending int;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'compute_payroll_run: admin only' using errcode = 'insufficient_privilege';
  end if;

  select * into run from payroll_runs where id = p_run_id;
  if run.id is null then raise exception 'payroll run % not found', p_run_id; end if;
  if run.status <> 'draft' then
    raise exception 'payroll run % is % — only draft runs may be computed', p_run_id, run.status;
  end if;

  select count(*) into v_unresolved from attendance_days
   where day between run.period_start and run.period_end and status = 'unresolved';
  if v_unresolved > 0 then
    raise exception 'cannot compute: % unresolved attendance day(s) in period', v_unresolved
      using errcode = 'check_violation';
  end if;

  select count(*) into v_pending from adjustments
   where day between run.period_start and run.period_end and status = 'pending';
  if v_pending > 0 then
    raise exception 'cannot compute: % pending adjustment(s) in period', v_pending
      using errcode = 'check_violation';
  end if;

  delete from payroll_lines where run_id = p_run_id;

  for w in
    select * from workers
    where is_active and joined_on <= run.period_end
      and (left_on is null or left_on >= run.period_start)
  loop
    v_daily := round(w.monthly_salary / v_divisor, 2);

    select
      count(*) filter (where ad.status = 'full_day'
                        and coalesce(cal.day_type,'working') in ('working','swapped_working')),
      count(*) filter (where ad.status = 'half_day'
                        and coalesce(cal.day_type,'working') in ('working','swapped_working')),
      count(*) filter (where ad.status = 'absent'
                        and coalesce(cal.day_type,'working') in ('working','swapped_working')),
      count(*) filter (where ad.status in ('full_day','half_day')
                        and coalesce(cal.day_type,'working') = 'extra_working')
    into v_full_days, v_half_days, v_absent_days, v_extra_days
    from attendance_days ad
    left join work_calendar cal on cal.day = ad.day
    where ad.worker_id = w.id and ad.day between run.period_start and run.period_end;

    v_full_days   := coalesce(v_full_days, 0);
    v_half_days   := coalesce(v_half_days, 0);
    v_absent_days := coalesce(v_absent_days, 0);
    v_extra_days  := coalesce(v_extra_days, 0);

    v_leave_units := v_absent_days + 0.5 * v_half_days;
    if v_leave_units <= v_free then v_deduction := 0;
    else v_deduction := round(v_leave_units * v_daily, 2); end if;
    v_extra_pay := round(v_extra_days * v_daily, 2);

    select coalesce(sum(amount), 0) into v_outstanding
    from advances
    where worker_id = w.id and status = 'approved'
      and disbursed_at is not null and recovered_in_run is null;

    -- Full recovery, no installments (spec §3.7.5) — but never a negative pay.
    -- If the full outstanding can't fit in this paycheck, defer the WHOLE advance
    -- to a later run. approve_payroll_run only marks an advance recovered when the
    -- line actually recovered it (advance_recovery component > 0).
    v_available := w.monthly_salary + v_extra_pay - v_deduction;
    if v_outstanding > 0 and v_outstanding <= v_available then
      v_recovery := v_outstanding;
    else
      v_recovery := 0;
    end if;

    v_net := w.monthly_salary + v_extra_pay - v_deduction - v_recovery;

    insert into payroll_lines
      (run_id, worker_id, salary_snapshot, daily_rate_snapshot,
       full_days, half_days, absent_days, extra_days, leave_units, net)
    values
      (p_run_id, w.id, w.monthly_salary, v_daily,
       v_full_days, v_half_days, v_absent_days, v_extra_days, v_leave_units, v_net)
    returning id into v_line_id;

    insert into payroll_line_components (line_id, code, label, type, amount) values
      (v_line_id, 'base_salary', 'Base salary', 'earning', w.monthly_salary);
    if v_extra_pay > 0 then
      insert into payroll_line_components (line_id, code, label, type, amount) values
        (v_line_id, 'extra_days', 'Extra days worked', 'earning', v_extra_pay);
    end if;
    if v_deduction > 0 then
      insert into payroll_line_components (line_id, code, label, type, amount) values
        (v_line_id, 'leave_deduction', 'Leave deduction', 'deduction', v_deduction);
    end if;
    if v_recovery > 0 then
      insert into payroll_line_components (line_id, code, label, type, amount) values
        (v_line_id, 'advance_recovery', 'Advance recovery', 'deduction', v_recovery);
    end if;
  end loop;

  update payroll_runs set computed_at = now() where id = p_run_id;
  perform public.write_audit('payroll_run_computed', 'payroll_runs', p_run_id::text, null,
    jsonb_build_object('period_start', run.period_start, 'period_end', run.period_end), null);
end;
$$;

-- ── #1: approve marks an advance recovered ONLY when it was actually deducted ─
create or replace function public.approve_payroll_run(p_run_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare run payroll_runs%rowtype;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'approve_payroll_run: admin only' using errcode = 'insufficient_privilege';
  end if;

  select * into run from payroll_runs where id = p_run_id for update;
  if run.id is null then raise exception 'payroll run % not found', p_run_id; end if;
  if run.status <> 'draft' then
    raise exception 'payroll run % is % — only draft runs can be approved', p_run_id, run.status;
  end if;

  -- Only advances that (a) existed at compute time (disbursed on/before
  -- computed_at) and (b) were actually recovered in the line (advance_recovery
  -- component > 0). Deferred advances stay outstanding for a later run.
  update advances a
  set recovered_in_run = p_run_id
  where a.status = 'approved' and a.disbursed_at is not null and a.recovered_in_run is null
    and a.disbursed_at <= coalesce(run.computed_at, now())
    and exists (
      select 1 from payroll_lines l
      join payroll_line_components c on c.line_id = l.id
      where l.run_id = p_run_id and l.worker_id = a.worker_id
        and c.code = 'advance_recovery' and c.amount > 0
    );

  update payroll_runs
  set status = 'admin_approved', approved_by = auth.uid(), approved_at = now()
  where id = p_run_id;

  perform public.write_audit('payroll_run_approved', 'payroll_runs', p_run_id::text,
    jsonb_build_object('status', 'draft'), jsonb_build_object('status', 'admin_approved'), null);
end;
$$;

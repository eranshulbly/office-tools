-- ============================================================================
-- 0003_functions.sql — core logic (spec §6). ALL attendance/payroll rules live
-- here as security-definer functions. attendance_days and payroll figures are
-- written ONLY through these. Every threshold is read from `settings`.
--
-- Admin-context guard pattern:
--   `if auth.uid() is not null and not is_admin() then raise`
-- Meaning: an authenticated caller must be an admin; a no-auth caller (service
-- role, cron, direct DB connection / tests) is trusted system context.
-- ============================================================================

-- ── Settings accessors (no magic numbers in code) ────────────────────────────
create or replace function public.setting_num(k text)
returns numeric language sql stable set search_path = public as $$
  select (value #>> '{}')::numeric from settings where key = k;
$$;

create or replace function public.setting_bool(k text)
returns boolean language sql stable set search_path = public as $$
  select (value #>> '{}')::boolean from settings where key = k;
$$;

create or replace function public.setting_text(k text)
returns text language sql stable set search_path = public as $$
  select (value #>> '{}') from settings where key = k;
$$;

create or replace function public.warehouse_tz()
returns text language sql stable set search_path = public as $$
  select coalesce(public.setting_text('warehouse_timezone'), 'Asia/Kolkata');
$$;

-- ── Audit helper ─────────────────────────────────────────────────────────────
create or replace function public.write_audit(
  p_action text, p_entity_table text, p_entity_id text,
  p_before jsonb, p_after jsonb, p_reason text
) returns void language sql security definer set search_path = public as $$
  insert into audit_log (actor_id, action, entity_table, entity_id, before_value, after_value, reason)
  values (auth.uid(), p_action, p_entity_table, p_entity_id, p_before, p_after, p_reason);
$$;

-- ── Dedupe: collapse punches within the window, across any device ─────────────
-- Greedy: keep a punch only if it is >= window after the previously kept punch.
-- Day boundary is the WAREHOUSE calendar day (local tz), per spec §3.1.
create or replace function public.dedupe_punch_times(p_worker uuid, p_day date, p_window_min numeric)
returns timestamptz[] language plpgsql stable security definer set search_path = public as $$
declare
  r record;
  kept timestamptz[] := '{}';
  last_kept timestamptz;
  tz text := public.warehouse_tz();
begin
  for r in
    select device_ts from raw_punches
    where worker_id = p_worker
      and (device_ts at time zone tz)::date = p_day
    order by device_ts
  loop
    if last_kept is null
       or r.device_ts >= last_kept + make_interval(mins => p_window_min::int) then
      kept := array_append(kept, r.device_ts);
      last_kept := r.device_ts;
    end if;
  end loop;
  return kept;
end;
$$;

-- ── recompute_attendance(from_date, to_date) ─────────────────────────────────
-- The ONLY writer of attendance_days. Idempotent: running twice is identical.
create or replace function public.recompute_attendance(from_date date, to_date date)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_full  numeric := public.setting_num('full_day_hours');
  v_half  numeric := public.setting_num('half_day_hours');
  v_break numeric := public.setting_num('break_deduction_minutes');
  v_win   numeric := public.setting_num('dedupe_window_minutes');
  d date;
  w record;
  cal_type calendar_day_type;
  kept timestamptz[];
  ts_set timestamptz[];
  adj adjustments%rowtype;
  v_first timestamptz;
  v_last  timestamptz;
  v_hours numeric;
  v_status day_status;
  v_from_adj boolean;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'recompute_attendance: admin only' using errcode = 'insufficient_privilege';
  end if;

  d := from_date;
  while d <= to_date loop
    select day_type into cal_type from work_calendar where day = d;
    if cal_type is null then cal_type := 'working'; end if;

    for w in
      select id from workers
      where is_active and joined_on <= d and (left_on is null or left_on >= d)
    loop
      v_from_adj := false; v_first := null; v_last := null; v_hours := null;

      if cal_type = 'closed' then
        v_status := 'not_working_day';
      else
        kept := public.dedupe_punch_times(w.id, d, v_win);

        select * into adj from adjustments
        where worker_id = w.id and day = d and status = 'approved'
        order by decided_at desc nulls last limit 1;

        if adj.id is not null then
          -- Adjustment is additive: combine its times with any real punches.
          v_from_adj := true;
          ts_set := kept;
          if adj.proposed_in  is not null then ts_set := array_append(ts_set, adj.proposed_in);  end if;
          if adj.proposed_out is not null then ts_set := array_append(ts_set, adj.proposed_out); end if;
          select min(t), max(t) into v_first, v_last from unnest(ts_set) t;
          v_hours := greatest(extract(epoch from (v_last - v_first)) / 3600.0 - v_break / 60.0, 0);
          v_status := case
            when v_hours >= v_full then 'full_day'::day_status
            when v_hours >= v_half then 'half_day'::day_status
            else 'absent'::day_status end;

        elsif coalesce(array_length(kept, 1), 0) = 0 then
          v_status := 'absent';

        elsif array_length(kept, 1) = 1 then
          -- Punched in, never out, nobody filed an adjustment. BLOCKS PAYROLL.
          v_status := 'unresolved';

        else
          select min(t), max(t) into v_first, v_last from unnest(kept) t;
          v_hours := greatest(extract(epoch from (v_last - v_first)) / 3600.0 - v_break / 60.0, 0);
          v_status := case
            when v_hours >= v_full then 'full_day'::day_status
            when v_hours >= v_half then 'half_day'::day_status
            else 'absent'::day_status end;
        end if;
      end if;

      insert into attendance_days
        (worker_id, day, first_in, last_out, worked_hours, status, is_from_adjustment, computed_at)
      values
        (w.id, d, v_first, v_last, round(v_hours, 2), v_status, v_from_adj, now())
      on conflict (worker_id, day) do update set
        first_in = excluded.first_in,
        last_out = excluded.last_out,
        worked_hours = excluded.worked_hours,
        status = excluded.status,
        is_from_adjustment = excluded.is_from_adjustment,
        computed_at = excluded.computed_at;
    end loop;

    d := d + 1;
  end loop;
end;
$$;

-- ── compute_payroll_run(run_id) ──────────────────────────────────────────────
-- Recomputable while draft. Writes payroll_lines + payroll_line_components.
-- net = sum(earnings) - sum(deductions). Never sets advance recovery flags;
-- that happens on approve.
create or replace function public.compute_payroll_run(p_run_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  run payroll_runs%rowtype;
  v_divisor numeric := public.setting_num('daily_rate_divisor');
  v_free    numeric := public.setting_num('free_leave_units');
  w record;
  v_daily numeric;
  v_full_days int;
  v_half_days int;
  v_absent_days int;
  v_extra_days int;
  v_leave_units numeric;
  v_deduction numeric;
  v_extra_pay numeric;
  v_advance numeric;
  v_net numeric;
  v_line_id uuid;
  v_unresolved int;
  v_pending int;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'compute_payroll_run: admin only' using errcode = 'insufficient_privilege';
  end if;

  select * into run from payroll_runs where id = p_run_id;
  if run.id is null then raise exception 'payroll run % not found', p_run_id; end if;
  if run.status <> 'draft' then
    raise exception 'payroll run % is % — only draft runs may be computed', p_run_id, run.status;
  end if;

  -- Guard 1: no unresolved days in the period (spec §3.6).
  select count(*) into v_unresolved
  from attendance_days
  where day between run.period_start and run.period_end and status = 'unresolved';
  if v_unresolved > 0 then
    raise exception 'cannot compute: % unresolved attendance day(s) in period', v_unresolved
      using errcode = 'check_violation';
  end if;

  -- Guard 2: no pending adjustments in the period (spec §3.6).
  select count(*) into v_pending
  from adjustments
  where day between run.period_start and run.period_end and status = 'pending';
  if v_pending > 0 then
    raise exception 'cannot compute: % pending adjustment(s) in period', v_pending
      using errcode = 'check_violation';
  end if;

  -- Clear any prior draft computation for this run.
  delete from payroll_lines where run_id = p_run_id;

  for w in
    select * from workers
    where is_active
      and joined_on <= run.period_end
      and (left_on is null or left_on >= run.period_start)
  loop
    v_daily := round(w.monthly_salary / v_divisor, 2);

    -- Day counts over the period. is_working = calendar day_type <> 'closed'.
    -- Leave counting (absent + half) is on NORMAL working days only
    -- (working, swapped_working) and EXCLUDES extra_working, consistent with
    -- `extra_day_absence_counts_as_leave = false`: an extra day can only ADD
    -- pay, never create a leave penalty. See NOTE in README (§ payroll).
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

    -- The leave-units formula (spec §3.3). Note the intentional cliff.
    v_leave_units := v_absent_days + 0.5 * v_half_days;
    if v_leave_units <= v_free then
      v_deduction := 0;
    else
      v_deduction := round(v_leave_units * v_daily, 2);   -- ALL units, not just excess
    end if;

    v_extra_pay := round(v_extra_days * v_daily, 2);

    -- Full outstanding recovered from the very next payroll (spec §3.7.5).
    select coalesce(sum(amount), 0) into v_advance
    from advances
    where worker_id = w.id and status = 'approved'
      and disbursed_at is not null and recovered_in_run is null;

    v_net := w.monthly_salary + v_extra_pay - v_deduction - v_advance;

    insert into payroll_lines
      (run_id, worker_id, salary_snapshot, daily_rate_snapshot,
       full_days, half_days, absent_days, extra_days, leave_units, net)
    values
      (p_run_id, w.id, w.monthly_salary, v_daily,
       v_full_days, v_half_days, v_absent_days, v_extra_days, v_leave_units, v_net)
    returning id into v_line_id;

    -- Components (spec §3.10): extensible; PF/ESI slot in here later.
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
    if v_advance > 0 then
      insert into payroll_line_components (line_id, code, label, type, amount) values
        (v_line_id, 'advance_recovery', 'Advance recovery', 'deduction', v_advance);
    end if;
  end loop;

  update payroll_runs set computed_at = now() where id = p_run_id;
  perform public.write_audit('payroll_run_computed', 'payroll_runs', p_run_id::text, null,
    jsonb_build_object('period_start', run.period_start, 'period_end', run.period_end), null);
end;
$$;

-- ── approve_payroll_run(run_id) ──────────────────────────────────────────────
-- Admin only. Freezes figures, marks recovered advances, writes audit.
create or replace function public.approve_payroll_run(p_run_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  run payroll_runs%rowtype;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'approve_payroll_run: admin only' using errcode = 'insufficient_privilege';
  end if;

  select * into run from payroll_runs where id = p_run_id for update;
  if run.id is null then raise exception 'payroll run % not found', p_run_id; end if;
  if run.status <> 'draft' then
    raise exception 'payroll run % is % — only draft runs can be approved', p_run_id, run.status;
  end if;

  -- Mark the advances that were recovered by this run (those counted in compute).
  update advances a
  set recovered_in_run = p_run_id
  where a.status = 'approved' and a.disbursed_at is not null and a.recovered_in_run is null
    and exists (select 1 from payroll_lines l where l.run_id = p_run_id and l.worker_id = a.worker_id);

  update payroll_runs
  set status = 'admin_approved', approved_by = auth.uid(), approved_at = now()
  where id = p_run_id;

  perform public.write_audit('payroll_run_approved', 'payroll_runs', p_run_id::text,
    jsonb_build_object('status', 'draft'), jsonb_build_object('status', 'admin_approved'), null);
end;
$$;

-- ── reopen_payroll_run(run_id) — logged LOUDLY (spec §3.8) ───────────────────
create or replace function public.reopen_payroll_run(p_run_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare run payroll_runs%rowtype;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'reopen_payroll_run: admin only' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reopening a run requires a reason';
  end if;

  select * into run from payroll_runs where id = p_run_id for update;
  if run.id is null then raise exception 'payroll run % not found', p_run_id; end if;
  if run.status <> 'admin_approved' then
    raise exception 'only admin_approved runs can be reopened (current: %)', run.status;
  end if;
  if exists (select 1 from payroll_lines where run_id = p_run_id and paid_at is not null) then
    raise exception 'cannot reopen: some lines are already paid';
  end if;

  -- Release the advances this run had marked recovered.
  update advances set recovered_in_run = null where recovered_in_run = p_run_id;

  update payroll_runs
  set status = 'draft', approved_by = null, approved_at = null
  where id = p_run_id;

  perform public.write_audit('payroll_run_REOPENED', 'payroll_runs', p_run_id::text,
    jsonb_build_object('status', 'admin_approved'), jsonb_build_object('status', 'draft'), p_reason);
end;
$$;

-- ── record_disbursal(line_id, mode, reference) — manager marks a line paid ────
-- Touches ONLY payment fields; never figures. Advances run status admin_approved
-- → disbursing on first payment, → closed when every line is paid.
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

  -- Close the run once every line is paid (spec §3.8: cannot close while unpaid).
  select count(*) into v_unpaid from payroll_lines where run_id = run.id and paid_at is null;
  if v_unpaid = 0 then
    update payroll_runs set status = 'closed', closed_at = now() where id = run.id;
  end if;

  perform public.write_audit('payroll_line_paid', 'payroll_lines', p_line_id::text, null,
    jsonb_build_object('pay_mode', p_mode, 'reference', p_reference), null);
end;
$$;

-- ── Adjustments: decision RPC (admin only) ───────────────────────────────────
create or replace function public.decide_adjustment(p_id uuid, p_approve boolean, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare adj adjustments%rowtype;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'decide_adjustment: admin only' using errcode = 'insufficient_privilege';
  end if;

  select * into adj from adjustments where id = p_id for update;
  if adj.id is null then raise exception 'adjustment % not found', p_id; end if;
  if adj.status <> 'pending' then raise exception 'adjustment % already decided', p_id; end if;
  if not p_approve and coalesce(trim(p_reason), '') = '' then
    raise exception 'rejection requires a reason';
  end if;

  -- Blocked for any period belonging to a closed payroll run (spec §3.5).
  if exists (select 1 from payroll_runs r
             where r.status = 'closed' and adj.day between r.period_start and r.period_end) then
    raise exception 'adjustment day % falls in a closed payroll run', adj.day;
  end if;

  update adjustments
  set status = case when p_approve then 'approved' else 'rejected' end::request_status,
      decided_by = auth.uid(), decided_at = now(), decision_reason = p_reason
  where id = p_id;

  perform public.write_audit(
    case when p_approve then 'adjustment_approved' else 'adjustment_rejected' end,
    'adjustments', p_id::text,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', case when p_approve then 'approved' else 'rejected' end),
    p_reason);

  -- Approval affects attendance immediately; rebuild just that day.
  if p_approve then
    perform public.recompute_attendance(adj.day, adj.day);
  end if;
end;
$$;

-- ── Advances: decision RPC (admin only) ──────────────────────────────────────
create or replace function public.decide_advance(p_id uuid, p_approve boolean, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare adv advances%rowtype;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'decide_advance: admin only' using errcode = 'insufficient_privilege';
  end if;

  select * into adv from advances where id = p_id for update;
  if adv.id is null then raise exception 'advance % not found', p_id; end if;
  if adv.status <> 'pending' then raise exception 'advance % already decided', p_id; end if;
  if not p_approve and coalesce(trim(p_reason), '') = '' then
    raise exception 'rejection requires a reason';
  end if;

  update advances
  set status = case when p_approve then 'approved' else 'rejected' end::request_status,
      decided_by = auth.uid(), decided_at = now(), decision_reason = p_reason
  where id = p_id;

  perform public.write_audit(
    case when p_approve then 'advance_approved' else 'advance_rejected' end,
    'advances', p_id::text,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', case when p_approve then 'approved' else 'rejected' end),
    p_reason);
end;
$$;

-- ── record_advance_disbursal(advance_id) — manager hands over cash ───────────
create or replace function public.record_advance_disbursal(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare adv advances%rowtype;
begin
  if auth.uid() is not null and not (public.is_manager() or public.is_admin()) then
    raise exception 'record_advance_disbursal: manager or admin only' using errcode = 'insufficient_privilege';
  end if;

  select * into adv from advances where id = p_id for update;
  if adv.id is null then raise exception 'advance % not found', p_id; end if;
  if adv.status <> 'approved' then raise exception 'advance % is not approved', p_id; end if;
  if adv.disbursed_at is not null then raise exception 'advance % already disbursed', p_id; end if;

  update advances set disbursed_at = now() where id = p_id;

  perform public.write_audit('advance_disbursed', 'advances', p_id::text, null,
    jsonb_build_object('disbursed_at', now()), null);
end;
$$;

-- ── Advance cap enforcement (spec §3.7.3): BLOCK the request, don't warn ──────
-- outstanding = approved + disbursed + unrecovered. Cap = salary * advance_cap_multiple.
create or replace function public.enforce_advance_cap()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_salary numeric;
  v_outstanding numeric;
  v_cap_mult numeric := public.setting_num('advance_cap_multiple');
begin
  select monthly_salary into v_salary from workers where id = new.worker_id;
  if v_salary is null then raise exception 'unknown worker %', new.worker_id; end if;

  select coalesce(sum(amount), 0) into v_outstanding
  from advances
  where worker_id = new.worker_id and status = 'approved'
    and disbursed_at is not null and recovered_in_run is null;

  if v_outstanding + new.amount > v_salary * v_cap_mult then
    raise exception
      'advance blocked: outstanding % + requested % exceeds cap % (salary % x %)',
      v_outstanding, new.amount, v_salary * v_cap_mult, v_salary, v_cap_mult
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists advances_cap_check on advances;
create trigger advances_cap_check
  before insert on advances
  for each row execute function public.enforce_advance_cap();

-- ── Adjustment period-open enforcement (spec §3.5.5) ─────────────────────────
create or replace function public.enforce_adjustment_period_open()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from payroll_runs r
             where r.status = 'closed' and new.day between r.period_start and r.period_end) then
    raise exception 'adjustment blocked: % falls in a closed payroll run', new.day
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists adjustments_period_check on adjustments;
create trigger adjustments_period_check
  before insert on adjustments
  for each row execute function public.enforce_adjustment_period_open();

-- ── Grants: authenticated users may call the RPCs (guards enforce role) ──────
grant execute on function
  public.recompute_attendance(date, date),
  public.compute_payroll_run(uuid),
  public.approve_payroll_run(uuid),
  public.reopen_payroll_run(uuid, text),
  public.record_disbursal(uuid, pay_mode, text),
  public.decide_adjustment(uuid, boolean, text),
  public.decide_advance(uuid, boolean, text),
  public.record_advance_disbursal(uuid)
to authenticated;

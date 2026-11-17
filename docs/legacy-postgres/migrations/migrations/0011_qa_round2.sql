-- ============================================================================
-- 0011_qa_round2.sql — fixes for the second QA round.
--   #2 bank details → admin-only table (hidden from managers)
--   #3 a lone punch after the cutoff is now 'late_review', not 'unresolved'
--   #4 disbursal scope snapshots the worker's group at compute time (stable per run)
--   #5 a bad late-cutoff setting no longer breaks recompute (defensive parse)
-- ============================================================================

-- ── #2: move bank details out of the manager-readable workers table ──────────
create table if not exists worker_bank_details (
  worker_id uuid primary key references workers(id) on delete cascade,
  bank_account text,
  bank_ifsc text,
  updated_at timestamptz default now()
);
-- Guarded so re-applying this migration (after the columns are already gone) is a no-op.
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'workers' and column_name = 'bank_account') then
    insert into worker_bank_details (worker_id, bank_account, bank_ifsc)
      select id, bank_account, bank_ifsc from workers
      where bank_account is not null or bank_ifsc is not null
    on conflict (worker_id) do nothing;
    alter table workers drop column bank_account;
    alter table workers drop column bank_ifsc;
  end if;
end $$;

alter table worker_bank_details enable row level security;
drop policy if exists wbd_admin_all on worker_bank_details;
create policy wbd_admin_all on worker_bank_details
  for all using (public.is_admin()) with check (public.is_admin());
-- No manager policy → managers cannot read or write bank details at all.

-- ── #4: snapshot the disbursal group on each payroll line ────────────────────
alter table payroll_lines add column if not exists group_id_snapshot uuid;

-- Access by GROUP (used with the line snapshot so an approved run's disbursal
-- responsibilities don't shift when a worker is later moved between groups).
create or replace function public.can_disburse_group(p_group uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or exists (select 1 from manager_group_access
                 where manager_id = auth.uid() and group_id = p_group);
$$;
grant execute on function public.can_disburse_group(uuid) to authenticated;

drop policy if exists payroll_lines_manager_select on payroll_lines;
create policy payroll_lines_manager_select on payroll_lines
  for select using (
    public.is_manager()
    and exists (
      select 1 from payroll_runs r
      where r.id = payroll_lines.run_id
        and r.status in ('admin_approved', 'disbursing', 'closed')
    )
    and public.can_disburse_group(payroll_lines.group_id_snapshot)
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
        and public.can_disburse_group(l.group_id_snapshot)
    )
  );

-- ── recompute_attendance — #3 (lone late punch) + #5 (safe cutoff parse) ──────
create or replace function public.recompute_attendance(from_date date, to_date date)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_full   numeric := public.setting_num('full_day_hours');
  v_break  numeric := public.setting_num('break_deduction_minutes');
  v_win    numeric := public.setting_num('dedupe_window_minutes');
  -- Defensive: a malformed cutoff setting must not break attendance/payroll.
  v_cutoff time := coalesce(
    (select case when (value #>> '{}') ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
                 then (value #>> '{}')::time else null end
     from settings where key = 'late_first_punch_cutoff'),
    time '22:00');
  tz text := public.warehouse_tz();
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
  v_review request_status;
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
          v_from_adj := true;
          ts_set := kept;
          if adj.proposed_in  is not null then ts_set := array_append(ts_set, adj.proposed_in);  end if;
          if adj.proposed_out is not null then ts_set := array_append(ts_set, adj.proposed_out); end if;
          select min(t), max(t) into v_first, v_last from unnest(ts_set) t;
          v_hours := greatest(extract(epoch from (v_last - v_first)) / 3600.0 - v_break / 60.0, 0);
          v_status := case when v_hours >= v_full then 'full_day'::day_status else 'absent'::day_status end;

        elsif coalesce(array_length(kept, 1), 0) = 0 then
          v_status := 'absent';

        else
          -- One or more punches: derive first/last, then apply the 10 PM rule to
          -- the FIRST punch. A lone punch that is NOT late stays 'unresolved'.
          select min(t), max(t) into v_first, v_last from unnest(kept) t;

          if (v_first at time zone tz)::time > v_cutoff then
            select status into v_review from late_arrival_reviews where worker_id = w.id and day = d;
            if v_review = 'approved' then
              v_hours := greatest(extract(epoch from (v_last - v_first)) / 3600.0 - v_break / 60.0, 0);
              v_status := 'full_day';
            elsif v_review = 'rejected' then
              v_status := 'absent';
            else
              v_status := 'late_review';
            end if;
          elsif array_length(kept, 1) = 1 then
            v_status := 'unresolved';                  -- dangling punch, not late
          else
            v_hours := greatest(extract(epoch from (v_last - v_first)) / 3600.0 - v_break / 60.0, 0);
            v_status := case when v_hours >= v_full then 'full_day'::day_status else 'absent'::day_status end;
          end if;
        end if;
      end if;

      insert into attendance_days
        (worker_id, day, first_in, last_out, worked_hours, status, is_from_adjustment, computed_at)
      values
        (w.id, d, v_first, v_last, round(v_hours, 2), v_status, v_from_adj, now())
      on conflict (worker_id, day) do update set
        first_in = excluded.first_in, last_out = excluded.last_out,
        worked_hours = excluded.worked_hours, status = excluded.status,
        is_from_adjustment = excluded.is_from_adjustment, computed_at = excluded.computed_at;
    end loop;

    d := d + 1;
  end loop;
end;
$$;

-- ── compute_payroll_run — set the group snapshot on each line ────────────────
create or replace function public.compute_payroll_run(p_run_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  run payroll_runs%rowtype;
  v_divisor numeric := public.setting_num('daily_rate_divisor');
  v_free    numeric := public.setting_num('free_leave_units');
  w record;
  v_daily numeric;
  v_full_days int; v_absent_days int; v_extra_days int;
  v_leave_units numeric; v_deduction numeric; v_extra_pay numeric;
  v_outstanding numeric; v_recovery numeric; v_available numeric;
  v_net numeric; v_line_id uuid;
  v_held int; v_pending int;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'compute_payroll_run: admin only' using errcode = 'insufficient_privilege';
  end if;

  select * into run from payroll_runs where id = p_run_id;
  if run.id is null then raise exception 'payroll run % not found', p_run_id; end if;
  if run.status <> 'draft' then
    raise exception 'payroll run % is % — only draft runs may be computed', p_run_id, run.status;
  end if;

  select count(*) into v_held from attendance_days
   where day between run.period_start and run.period_end and status in ('unresolved', 'late_review');
  if v_held > 0 then
    raise exception 'cannot compute: % held attendance day(s) (unresolved or late-review) in period', v_held
      using errcode = 'check_violation';
  end if;

  select count(*) into v_pending from adjustments
   where day between run.period_start and run.period_end and status = 'pending';
  if v_pending > 0 then
    raise exception 'cannot compute: % pending adjustment(s) in period', v_pending using errcode = 'check_violation';
  end if;

  delete from payroll_lines where run_id = p_run_id;

  for w in
    select * from workers
    where is_active and joined_on <= run.period_end
      and (left_on is null or left_on >= run.period_start)
  loop
    v_daily := round(w.monthly_salary / v_divisor, 2);

    select
      count(*) filter (where ad.status = 'full_day' and coalesce(cal.day_type,'working') in ('working','swapped_working')),
      count(*) filter (where ad.status = 'absent'   and coalesce(cal.day_type,'working') in ('working','swapped_working')),
      count(*) filter (where ad.status = 'full_day' and coalesce(cal.day_type,'working') = 'extra_working')
    into v_full_days, v_absent_days, v_extra_days
    from attendance_days ad
    left join work_calendar cal on cal.day = ad.day
    where ad.worker_id = w.id and ad.day between run.period_start and run.period_end;

    v_full_days := coalesce(v_full_days,0); v_absent_days := coalesce(v_absent_days,0); v_extra_days := coalesce(v_extra_days,0);

    v_leave_units := v_absent_days;
    if v_leave_units <= v_free then v_deduction := 0; else v_deduction := round(v_leave_units * v_daily, 2); end if;
    v_extra_pay := round(v_extra_days * v_daily, 2);

    select coalesce(sum(amount), 0) into v_outstanding
    from advances where worker_id = w.id and status = 'approved' and disbursed_at is not null and recovered_in_run is null;

    v_available := w.monthly_salary + v_extra_pay - v_deduction;
    if v_outstanding > 0 and v_outstanding <= v_available then v_recovery := v_outstanding; else v_recovery := 0; end if;

    v_net := w.monthly_salary + v_extra_pay - v_deduction - v_recovery;

    insert into payroll_lines
      (run_id, worker_id, group_id_snapshot, salary_snapshot, daily_rate_snapshot,
       full_days, half_days, absent_days, extra_days, leave_units, net)
    values
      (p_run_id, w.id, w.group_id, w.monthly_salary, v_daily,
       v_full_days, 0, v_absent_days, v_extra_days, v_leave_units, v_net)
    returning id into v_line_id;

    insert into payroll_line_components (line_id, code, label, type, amount) values
      (v_line_id, 'base_salary', 'Base salary', 'earning', w.monthly_salary);
    if v_extra_pay > 0 then insert into payroll_line_components (line_id, code, label, type, amount) values (v_line_id, 'extra_days', 'Extra days worked', 'earning', v_extra_pay); end if;
    if v_deduction > 0 then insert into payroll_line_components (line_id, code, label, type, amount) values (v_line_id, 'leave_deduction', 'Leave deduction', 'deduction', v_deduction); end if;
    if v_recovery > 0 then insert into payroll_line_components (line_id, code, label, type, amount) values (v_line_id, 'advance_recovery', 'Advance recovery', 'deduction', v_recovery); end if;
  end loop;

  update payroll_runs set computed_at = now() where id = p_run_id;
  perform public.write_audit('payroll_run_computed', 'payroll_runs', p_run_id::text, null,
    jsonb_build_object('period_start', run.period_start, 'period_end', run.period_end), null);
end;
$$;

-- ── record_disbursal — scope by the line's group snapshot ────────────────────
create or replace function public.record_disbursal(p_line_id uuid, p_mode pay_mode, p_reference text)
returns void language plpgsql security definer set search_path = public as $$
declare line payroll_lines%rowtype; run payroll_runs%rowtype; v_unpaid int;
begin
  if auth.uid() is not null and not (public.is_manager() or public.is_admin()) then
    raise exception 'record_disbursal: manager or admin only' using errcode = 'insufficient_privilege';
  end if;
  if p_mode is null then raise exception 'a pay mode (cash or online) is required'; end if;

  select * into line from payroll_lines where id = p_line_id for update;
  if line.id is null then raise exception 'payroll line % not found', p_line_id; end if;
  if line.paid_at is not null then raise exception 'line % is already paid', p_line_id; end if;

  if auth.uid() is not null and public.is_manager() and not public.is_admin()
     and not public.can_disburse_group(line.group_id_snapshot) then
    raise exception 'you are not allowed to disburse this worker''s group'
      using errcode = 'insufficient_privilege';
  end if;

  select * into run from payroll_runs where id = line.run_id for update;
  if run.status not in ('admin_approved', 'disbursing') then
    raise exception 'run is % — disbursal not allowed', run.status;
  end if;

  update payroll_lines set pay_mode = p_mode, paid_at = now(), paid_by = auth.uid(), payment_reference = p_reference where id = p_line_id;
  if run.status = 'admin_approved' then update payroll_runs set status = 'disbursing' where id = run.id; end if;
  select count(*) into v_unpaid from payroll_lines where run_id = run.id and paid_at is null;
  if v_unpaid = 0 then update payroll_runs set status = 'closed', closed_at = now() where id = run.id; end if;

  perform public.write_audit('payroll_line_paid', 'payroll_lines', p_line_id::text, null,
    jsonb_build_object('pay_mode', p_mode, 'reference', p_reference), null);
end;
$$;

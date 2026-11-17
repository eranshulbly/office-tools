-- ============================================================================
-- 0009_two_state_and_late.sql
--   • Remove half-day: a day is present (full_day) only if worked_hours reaches
--     full_day_hours; otherwise absent (full-day leave). leave_units = absent_days.
--   • 10 PM rule: if the day's FIRST punch is after late_first_punch_cutoff, the
--     day is held as 'late_review' (blocks payroll) until an admin approves it
--     (→ present) or rejects it (→ absent).
--   • Worker phone + sms_enabled flag (SMS itself deferred).
-- ============================================================================

-- ── settings ─────────────────────────────────────────────────────────────────
delete from settings where key = 'half_day_hours';   -- half-day removed

insert into settings (key, value, description) values
  ('late_first_punch_cutoff', '"22:00"', 'Warehouse-local time; a first punch after this holds the day for admin review (10 PM rule)'),
  ('sms_enabled',             'false',   'Send an SMS to the worker on disbursal (requires a provider; off for now)')
on conflict (key) do nothing;

alter table workers add column if not exists phone text;

-- ── late-arrival reviews (admin decisions the recompute reads) ───────────────
create table if not exists late_arrival_reviews (
  worker_id uuid not null references workers(id),
  day date not null,
  status request_status not null default 'pending',
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  reason text,
  primary key (worker_id, day)
);
alter table late_arrival_reviews enable row level security;

drop policy if exists late_reviews_select on late_arrival_reviews;
create policy late_reviews_select on late_arrival_reviews
  for select using (auth.uid() is not null);

drop policy if exists late_reviews_admin_all on late_arrival_reviews;
create policy late_reviews_admin_all on late_arrival_reviews
  for all using (public.is_admin()) with check (public.is_admin());

-- ── recompute_attendance — 2-state classification + late-punch hold ──────────
create or replace function public.recompute_attendance(from_date date, to_date date)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_full   numeric := public.setting_num('full_day_hours');
  v_break  numeric := public.setting_num('break_deduction_minutes');
  v_win    numeric := public.setting_num('dedupe_window_minutes');
  v_cutoff time    := coalesce(public.setting_text('late_first_punch_cutoff'), '22:00')::time;
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
          -- Admin-approved adjustment: use its times; 2-state, no late-hold.
          v_from_adj := true;
          ts_set := kept;
          if adj.proposed_in  is not null then ts_set := array_append(ts_set, adj.proposed_in);  end if;
          if adj.proposed_out is not null then ts_set := array_append(ts_set, adj.proposed_out); end if;
          select min(t), max(t) into v_first, v_last from unnest(ts_set) t;
          v_hours := greatest(extract(epoch from (v_last - v_first)) / 3600.0 - v_break / 60.0, 0);
          v_status := case when v_hours >= v_full then 'full_day'::day_status else 'absent'::day_status end;

        elsif coalesce(array_length(kept, 1), 0) = 0 then
          v_status := 'absent';

        elsif array_length(kept, 1) = 1 then
          v_status := 'unresolved';                     -- dangling punch (blocks payroll)

        else
          select min(t), max(t) into v_first, v_last from unnest(kept) t;

          if (v_first at time zone tz)::time > v_cutoff then
            -- 10 PM rule: first punch after cutoff → held for admin review.
            select status into v_review from late_arrival_reviews where worker_id = w.id and day = d;
            if v_review = 'approved' then
              v_hours := greatest(extract(epoch from (v_last - v_first)) / 3600.0 - v_break / 60.0, 0);
              v_status := 'full_day';                   -- approved late day counts present
            elsif v_review = 'rejected' then
              v_status := 'absent';
            else
              v_status := 'late_review';                -- pending (blocks payroll)
            end if;
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

-- ── decide_late_review — admin approves/rejects a held late day ──────────────
create or replace function public.decide_late_review(p_worker uuid, p_day date, p_approve boolean, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'decide_late_review: admin only' using errcode = 'insufficient_privilege';
  end if;
  if not p_approve and coalesce(trim(p_reason), '') = '' then
    raise exception 'rejection requires a reason';
  end if;

  insert into late_arrival_reviews (worker_id, day, status, decided_by, decided_at, reason)
  values (p_worker, p_day, case when p_approve then 'approved' else 'rejected' end::request_status,
          auth.uid(), now(), p_reason)
  on conflict (worker_id, day) do update
    set status = excluded.status, decided_by = excluded.decided_by,
        decided_at = excluded.decided_at, reason = excluded.reason;

  perform public.write_audit(
    case when p_approve then 'late_day_approved' else 'late_day_rejected' end,
    'attendance_days', p_worker::text || ':' || p_day::text,
    null, jsonb_build_object('day', p_day, 'approved', p_approve), p_reason);

  perform public.recompute_attendance(p_day, p_day);
end;
$$;
grant execute on function public.decide_late_review(uuid, date, boolean, text) to authenticated;

-- ── compute_payroll_run — no half-day; block late_review like unresolved ─────
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

  -- Held days (dangling punches OR late days awaiting review) block payroll.
  select count(*) into v_held from attendance_days
   where day between run.period_start and run.period_end
     and status in ('unresolved', 'late_review');
  if v_held > 0 then
    raise exception 'cannot compute: % held attendance day(s) (unresolved or late-review) in period', v_held
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
      count(*) filter (where ad.status = 'absent'
                        and coalesce(cal.day_type,'working') in ('working','swapped_working')),
      count(*) filter (where ad.status = 'full_day'
                        and coalesce(cal.day_type,'working') = 'extra_working')
    into v_full_days, v_absent_days, v_extra_days
    from attendance_days ad
    left join work_calendar cal on cal.day = ad.day
    where ad.worker_id = w.id and ad.day between run.period_start and run.period_end;

    v_full_days   := coalesce(v_full_days, 0);
    v_absent_days := coalesce(v_absent_days, 0);
    v_extra_days  := coalesce(v_extra_days, 0);

    v_leave_units := v_absent_days;                    -- no half-days
    if v_leave_units <= v_free then v_deduction := 0;
    else v_deduction := round(v_leave_units * v_daily, 2); end if;
    v_extra_pay := round(v_extra_days * v_daily, 2);

    select coalesce(sum(amount), 0) into v_outstanding
    from advances
    where worker_id = w.id and status = 'approved'
      and disbursed_at is not null and recovered_in_run is null;

    v_available := w.monthly_salary + v_extra_pay - v_deduction;
    if v_outstanding > 0 and v_outstanding <= v_available then
      v_recovery := v_outstanding;
    else
      v_recovery := 0;                                 -- defer whole advance; never negative net
    end if;

    v_net := w.monthly_salary + v_extra_pay - v_deduction - v_recovery;

    insert into payroll_lines
      (run_id, worker_id, salary_snapshot, daily_rate_snapshot,
       full_days, half_days, absent_days, extra_days, leave_units, net)
    values
      (p_run_id, w.id, w.monthly_salary, v_daily,
       v_full_days, 0, v_absent_days, v_extra_days, v_leave_units, v_net)
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

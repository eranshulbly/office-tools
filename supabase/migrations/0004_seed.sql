-- ============================================================================
-- 0004_seed.sql — seed settings (§4.1) and the working calendar (Sundays closed).
-- Idempotent: safe to re-run. Values are the client defaults; admin edits in UI.
-- ============================================================================

insert into settings (key, value, description) values
  ('full_day_hours',                    '7',              'Clock-to-clock hours for a full day'),
  ('half_day_hours',                    '4',              'Clock-to-clock hours for a half day'),
  ('break_deduction_minutes',           '0',              'Minutes deducted from total before classifying — confirm with client'),
  ('dedupe_window_minutes',             '2',              'Punches within this window (any device) collapse to one event'),
  ('free_leave_units',                  '1',              'Leave units granted free before any deduction'),
  ('daily_rate_divisor',                '30',             'daily_rate = monthly_salary / this. Always 30.'),
  ('overtime_enabled',                  'false',          'OT is not paid. Do not enable.'),
  ('extra_day_absence_counts_as_leave', 'false',          'Absence on an extra_working day is not a leave'),
  ('advance_cap_multiple',              '1.0',            'outstanding + requested must not exceed salary x this'),
  ('payroll_period_start_day',          '10',             'Period starts on this day of month M-1'),
  ('payroll_period_end_day',            '9',              'Period ends on this day of month M'),
  ('payroll_pay_day',                   '10',             'Default pay date, day of month M (admin-adjustable)'),
  ('manual_entry_alert_threshold',      '3',              'Surface workers with more approved adjustments than this per period'),
  ('device_offline_alert_hours',        '2',              'Alert if a device has not checked in for this many working hours'),
  ('clock_drift_alert_minutes',         '5',              'Alert when device_ts and server_ts diverge beyond this'),
  ('warehouse_timezone',                '"Asia/Kolkata"', 'Calendar-day boundary timezone (spec §9: store UTC, bucket local)')
on conflict (key) do nothing;

-- Seed the calendar: default working, Sundays closed, for a date range.
create or replace function public.seed_default_calendar(p_from date, p_to date)
returns void language plpgsql set search_path = public as $$
declare d date := p_from;
begin
  while d <= p_to loop
    insert into work_calendar (day, day_type, note)
    values (d,
            (case when extract(dow from d) = 0 then 'closed' else 'working' end)::calendar_day_type,
            case when extract(dow from d) = 0 then 'Weekly off (Sunday)' else null end)
    on conflict (day) do nothing;   -- never clobber an admin override
    d := d + 1;
  end loop;
end;
$$;

-- Seed a generous window around the current period. Extend later as needed.
select public.seed_default_calendar(date '2026-01-01', date '2027-12-31');

-- ============================================================================
-- 0014_calendar_month_period.sql — payroll period is now the full CALENDAR MONTH
-- (1st → last day), e.g. June = 1–30 June, disbursed manually (default pay date
-- = 2nd Saturday of the next month). The engine already computes over each run's
-- stored period_start/period_end, so no function change is needed — only the
-- obsolete day-of-month settings are removed (the app derives the calendar month
-- and the 2nd-Saturday default itself now).
-- ============================================================================

delete from settings where key in
  ('payroll_period_start_day', 'payroll_period_end_day', 'payroll_pay_day');

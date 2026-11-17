-- ============================================================================
-- 0001_schema.sql — tables, types, indexes (spec §4)
-- Modular monolith. One database. All modules share it.
-- ============================================================================

-- ============ CORE ============

do $$ begin
  create type user_role as enum ('admin', 'manager');
exception when duplicate_object then null; end $$;

create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text not null,
  role user_role not null,
  created_at timestamptz default now()
);

create table if not exists settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_at timestamptz default now(),
  updated_by uuid references profiles(id)
);

create table if not exists workers (
  id uuid primary key default gen_random_uuid(),
  employee_code text unique not null,
  full_name text not null,
  device_user_id int unique not null,   -- the PIN enrolled on the K40 Pro
  monthly_salary numeric(10,2) not null check (monthly_salary > 0),
  bank_account text,
  bank_ifsc text,
  joined_on date not null,
  left_on date,
  is_active boolean not null default true,
  created_at timestamptz default now()
);

create table if not exists devices (
  serial_number text primary key,
  label text not null,
  last_seen_at timestamptz,
  last_device_time timestamptz,          -- for clock-drift detection
  is_active boolean default true
);

-- ============ ATTENDANCE ============

-- APPEND ONLY. No UPDATE. No DELETE. Enforced by RLS + trigger (see 0002).
create table if not exists raw_punches (
  id bigserial primary key,
  device_serial text not null references devices(serial_number),
  device_user_id int not null,
  worker_id uuid references workers(id),   -- resolved on ingest; null if unknown
  device_ts timestamptz not null,          -- what the device said
  server_ts timestamptz not null default now(),
  verify_mode smallint,
  raw_line text not null,                  -- the original TSV line, verbatim
  created_at timestamptz default now()
);
create index if not exists raw_punches_worker_ts_idx on raw_punches (worker_id, device_ts);

do $$ begin
  create type calendar_day_type as enum
    ('working', 'closed', 'extra_working', 'swapped_working');
exception when duplicate_object then null; end $$;

create table if not exists work_calendar (
  day date primary key,
  day_type calendar_day_type not null default 'working',
  note text,
  updated_by uuid references profiles(id),
  updated_at timestamptz default now()
);

do $$ begin
  create type day_status as enum
    ('full_day', 'half_day', 'absent', 'unresolved', 'not_working_day');
exception when duplicate_object then null; end $$;

-- DERIVED. Safe to TRUNCATE and rebuild from raw_punches + adjustments + calendar.
create table if not exists attendance_days (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references workers(id),
  day date not null,
  first_in timestamptz,
  last_out timestamptz,
  worked_hours numeric(5,2),
  status day_status not null,
  is_from_adjustment boolean not null default false,
  computed_at timestamptz not null default now(),
  unique (worker_id, day)
);
create index if not exists attendance_days_day_status_idx on attendance_days (day, status);

do $$ begin
  create type request_status as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

create table if not exists adjustments (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references workers(id),
  day date not null,
  proposed_in timestamptz,
  proposed_out timestamptz,
  reason text not null,
  status request_status not null default 'pending',
  requested_by uuid not null references profiles(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  decision_reason text
);
create index if not exists adjustments_worker_day_idx on adjustments (worker_id, day);
create index if not exists adjustments_status_idx on adjustments (status);

-- ============ ADVANCES ============

create table if not exists advances (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references workers(id),
  amount numeric(10,2) not null check (amount > 0),
  reason text not null,
  status request_status not null default 'pending',
  requested_by uuid not null references profiles(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  decision_reason text,
  disbursed_at timestamptz,               -- approval != payment
  recovered_in_run uuid                   -- FK to payroll_runs, added below
);
create index if not exists advances_worker_idx on advances (worker_id);
create index if not exists advances_status_idx on advances (status);

-- ============ PAYROLL ============

do $$ begin
  create type run_status as enum
    ('draft', 'admin_approved', 'disbursing', 'closed');
exception when duplicate_object then null; end $$;

create table if not exists payroll_runs (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,             -- 10th of M-1
  period_end date not null,               -- 9th of M
  pay_date date not null,                 -- default 10th of M, admin-adjustable
  status run_status not null default 'draft',
  computed_at timestamptz,
  approved_by uuid references profiles(id),
  approved_at timestamptz,
  closed_at timestamptz,
  unique (period_start, period_end)
);

-- Now that payroll_runs exists, wire the advances recovery FK.
do $$ begin
  alter table advances
    add constraint advances_recovered_in_run_fkey
    foreign key (recovered_in_run) references payroll_runs(id);
exception when duplicate_object then null; end $$;

do $$ begin
  create type pay_mode as enum ('cash', 'online');
exception when duplicate_object then null; end $$;

create table if not exists payroll_lines (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references payroll_runs(id) on delete cascade,
  worker_id uuid not null references workers(id),

  -- SNAPSHOTS. Never read these from workers at display time.
  salary_snapshot numeric(10,2) not null,
  daily_rate_snapshot numeric(10,2) not null,

  full_days int not null default 0,
  half_days int not null default 0,
  absent_days int not null default 0,
  extra_days int not null default 0,
  leave_units numeric(5,2) not null default 0,

  net numeric(10,2) not null,             -- = sum(components)

  pay_mode pay_mode,
  paid_at timestamptz,
  paid_by uuid references profiles(id),
  payment_reference text,                 -- optional UTR
  unique (run_id, worker_id)
);
create index if not exists payroll_lines_run_idx on payroll_lines (run_id);

do $$ begin
  create type component_type as enum ('earning', 'deduction');
exception when duplicate_object then null; end $$;

-- Extensible: PF/ESI slot in here later with no migration (spec §3.10).
create table if not exists payroll_line_components (
  id uuid primary key default gen_random_uuid(),
  line_id uuid not null references payroll_lines(id) on delete cascade,
  code text not null,      -- base_salary | leave_deduction | extra_days | advance_recovery | pf_employee | ...
  label text not null,
  type component_type not null,
  amount numeric(10,2) not null
);
create index if not exists payroll_line_components_line_idx on payroll_line_components (line_id);

-- ============ AUDIT ============

create table if not exists audit_log (
  id bigserial primary key,
  actor_id uuid references profiles(id),
  action text not null,
  entity_table text not null,
  entity_id text not null,
  before_value jsonb,
  after_value jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_entity_idx on audit_log (entity_table, entity_id);
create index if not exists audit_log_actor_idx on audit_log (actor_id, created_at);

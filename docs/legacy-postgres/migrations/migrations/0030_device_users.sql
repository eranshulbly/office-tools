-- ============================================================================
-- 0030_device_users.sql — the enrolled-user list read back from the terminal.
--
-- The device knows each person as a numeric User ID plus a short name. Pulling
-- that list lets an admin map PIN -> employee by picking a name instead of
-- typing numbers (a mistyped PIN silently gives one person another's
-- attendance). Fingerprint templates ("FP ..." lines) are NEVER stored — only
-- the id and name.
-- ============================================================================

create table if not exists device_users (
  device_serial text not null references devices(serial_number) on delete cascade,
  pin           int  not null,
  name          text,
  updated_at    timestamptz not null default now(),
  primary key (device_serial, pin)
);

alter table device_users enable row level security;

drop policy if exists device_users_admin_all on device_users;
create policy device_users_admin_all on device_users
  for all using (public.is_admin()) with check (public.is_admin());

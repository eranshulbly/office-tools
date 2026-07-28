-- ============================================================================
-- 0031_device_clock_offset.sql — per-terminal clock correction.
--
-- Some terminals are hard-locked to a timezone they can't be moved off (ours
-- sits on GMT+8, the vendor default, with no timezone menu, and ACKs but
-- ignores both "SET OPTIONS DateTime" and "SET OPTIONS TimeZone"). The clock is
-- therefore wrong by a FIXED amount, which we correct on ingest.
--
-- clock_offset_minutes = how far AHEAD the device clock runs vs real local time.
-- The gateway subtracts it, so device_ts is a true instant. raw_line still holds
-- the device's original text verbatim, so nothing is lost for audit.
-- ============================================================================

alter table public.devices
  add column if not exists clock_offset_minutes int not null default 0;

comment on column public.devices.clock_offset_minutes is
  'Minutes the device clock runs AHEAD of real local time; subtracted by the gateway on ingest.';

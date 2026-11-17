-- ============================================================================
-- 0032_drop_device_clock_offset.sql — revert 0031.
--
-- The terminal's clock was corrected on the device itself, so the ingest-side
-- correction is no longer needed (and would now skew timestamps the other way).
-- device_ts is stored exactly as the device reports it again; the device_ts vs
-- server_ts drift canary is the sole clock check once more.
-- ============================================================================

alter table public.devices drop column if exists clock_offset_minutes;

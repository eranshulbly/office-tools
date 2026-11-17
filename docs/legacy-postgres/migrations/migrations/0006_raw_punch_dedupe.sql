-- ============================================================================
-- 0006_raw_punch_dedupe.sql — make gateway forwarding idempotent.
-- The store-and-forward gateway may re-send a batch after a crash. A unique
-- index lets those inserts use ON CONFLICT DO NOTHING so re-sends never create
-- duplicate rows. (A single fingerprint can't produce two events at the exact
-- same second on the same device, so this constraint only ever blocks re-sends.)
-- This is an INSERT-only guard; it does not violate the append-only rule.
-- ============================================================================

create unique index if not exists raw_punches_dedupe_uidx
  on raw_punches (device_serial, device_user_id, device_ts);

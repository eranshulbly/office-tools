-- ============================================================================
-- 0027_upi_mapping_firm.sql — make UPI mappings firm-specific. Every mapping
-- belongs to a firm (Anmol Associates / Om Marketing); existing rows default to
-- Anmol Associates. Uniqueness of a UPI id is now per firm (the same UPI id can
-- be mapped under each firm). Idempotent.
-- ============================================================================

alter table public.upi_mappings
  add column if not exists firm text not null default 'Anmol Associates';

-- Uniqueness moves from (upi_id) to (firm, upi_id).
drop index if exists upi_mappings_upi_id_key;
create unique index if not exists upi_mappings_firm_upi_id_key
  on public.upi_mappings (firm, lower(upi_id));

-- ============================================================================
-- 0026_upi_mapping_extra_cols.sql — carry the source file's "alt dealer" and
-- "review" columns on each UPI→dealer mapping. Idempotent.
-- ============================================================================

alter table public.upi_mappings add column if not exists alt_dealer text;
alter table public.upi_mappings add column if not exists review text;

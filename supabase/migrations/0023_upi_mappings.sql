-- ============================================================================
-- 0023_upi_mappings.sql — UPI Reconciliation. Admins store UPI-ID → dealer name
-- mappings; a bank statement upload then labels each UPI transaction with the
-- dealer it belongs to. Admin-only. Idempotent.
-- ============================================================================

create table if not exists upi_mappings (
  id          uuid primary key default gen_random_uuid(),
  upi_id      text not null,             -- the VPA, e.g. 9027705441@axl
  dealer_name text not null,
  created_at  timestamptz not null default now()
);
-- One dealer per UPI id (case-insensitive).
create unique index if not exists upi_mappings_upi_id_key on upi_mappings (lower(upi_id));

alter table upi_mappings enable row level security;
drop policy if exists upi_mappings_admin_all on upi_mappings;
create policy upi_mappings_admin_all on upi_mappings
  for all using (public.is_admin()) with check (public.is_admin());

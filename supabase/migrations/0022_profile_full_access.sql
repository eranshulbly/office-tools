-- ============================================================================
-- 0022_profile_full_access.sql — per-user access flag. Admins always have full
-- access (role check); managers with full_access = true see all suites, while
-- managers WITHOUT it see HR & Payroll as "coming soon" (Cheque Reconciliation
-- only). New managers default to false, so freshly-created manager logins are
-- Cheque-only until an admin grants them more. Idempotent.
-- ============================================================================

alter table profiles add column if not exists full_access boolean not null default false;

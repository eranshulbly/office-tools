-- ============================================================================
-- 0021_bank_account_payee.sql — link each of OUR bank accounts to a PAYEE company
-- (the cheque is payable to one of our companies — Anmol Associates / Om Marketing).
-- When a cheque with that payee is presented, the reconciliation form auto-selects
-- the matching account. Nullable (an account may be unassigned). Idempotent.
-- ============================================================================

alter table company_bank_accounts add column if not exists payee text;

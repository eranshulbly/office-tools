-- ============================================================================
-- upi_payer_accounts — payer bank account → dealer, per firm.
--
-- Since 14 Oct 2026 HDFC masks the payer's UPI ID in statement narrations
-- ("UPI-924020001260349-******3148@PTAXIS-…") but still prints the payer's
-- account number in full. This table lets the reconcile screen recognise a
-- payer by that account number. Rows come from: confirming a match on the
-- reconcile screen (source 'manual'), saving accounts a statement taught us
-- ('statement'), and the bulk upload on /upi ('bulk').
--
-- Apply once against the app's MySQL database (MySQL 8.0.13+ for the
-- expression default). Safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS upi_payer_accounts (
  id            CHAR(36)     NOT NULL DEFAULT (UUID()),
  firm          VARCHAR(100) NOT NULL,
  payer_account VARCHAR(40)  NOT NULL,
  dealer_name   VARCHAR(255) NOT NULL,
  source        VARCHAR(20)  NOT NULL DEFAULT 'manual',
  sample_vpa    VARCHAR(255) NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- One dealer per account per firm; confirming again overwrites the dealer.
  UNIQUE KEY upi_payer_accounts_firm_account_key (firm, payer_account)
);

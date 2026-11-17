/**
 * `ops_manager` is a deliberately narrow role: capture cheques and hand them to
 * the bank, nothing else. No totals, no outcomes, no ledger, no bank accounts.
 * It is not "manager with fewer tick-boxes" — it is a separate role so the
 * restriction is enforced by the authorization map rather than by hiding UI.
 */
/**
 * `ops_manager_hr` is the HR counterpart: everything a manager can do inside
 * the HR System, and nothing outside it. Not "manager minus the other suites"
 * — like ops_manager it is enumerated explicitly in the authorization map, so
 * a table added elsewhere in the app cannot quietly widen its reach.
 */
export type Role = "admin" | "manager" | "ops_manager" | "ops_manager_hr";

export type Profile = {
  id: string;
  full_name: string;
  role: Role;
  full_access: boolean; // managers: false = Cheque-only (HR/Payroll coming soon)
  created_at: string;
};

export type CalendarDayType = "working" | "closed" | "extra_working" | "swapped_working";
// half_day is retained in the enum for history but is never produced anymore
// (2-state model: present or absent). late_review = held by the 10 PM rule.
export type DayStatus =
  | "full_day"
  | "half_day"
  | "absent"
  | "unresolved"
  | "not_working_day"
  | "late_review";

export type WorkerGroup = { id: string; name: string; created_at: string };
export type RequestStatus = "pending" | "approved" | "rejected";
export type RunStatus = "draft" | "admin_approved" | "disbursing" | "closed";
export type PayMode = "cash" | "online";
export type ComponentType = "earning" | "deduction";

export type Worker = {
  id: string;
  employee_code: string;
  full_name: string;
  /** Job title. Pushed to the attendance terminal as "Name - Designation". */
  designation: string | null;
  /**
   * The name WITHOUT the designation appended. Reads through the query builder
   * return `full_name` already combined for display; edit forms must use this
   * one, or saving would persist the combined string and it would grow another
   * designation on the next render.
   */
  full_name_only?: string;
  device_user_id: number | null; // optional — assigned when enrolled on the punch device
  monthly_salary: number | null; // null while a manager-added worker is pending
  joined_on: string;
  left_on: string | null;
  is_active: boolean;
  group_id: string | null;
  phone: string | null;
  approval_status: "active" | "pending" | "rejected";
  photo_path: string | null;
  id_proof_path: string | null;
  created_at: string;
};

// Bank details live in a separate admin-only table (managers must not see them).
export type WorkerBankDetails = {
  worker_id: string;
  bank_account: string | null;
  bank_ifsc: string | null;
};

// ── Cheque Reconciliation ──
// draft → pending → (rejected → draft) → submitted → presented → passed | bounced
export type ChequeStatus =
  | "draft"
  | "pending"
  | "rejected"
  | "submitted"
  | "presented"
  | "passed"
  | "bounced";

export type CompanyBankAccount = {
  id: string;
  label: string;
  bank_name: string | null;
  account_number: string | null;
  ifsc: string | null;
  payee: string | null; // the payee company this account belongs to
  is_active: boolean;
  created_at: string;
};

export type Cheque = {
  id: string;
  status: ChequeStatus;
  cheque_number: string | null;
  cheque_date: string | null;
  received_date: string | null;
  amount: number | null;
  amount_in_words: string | null;
  dealer_name: string | null;
  bank_name: string | null;
  branch: string | null;
  ifsc: string | null;
  account_number: string | null;
  micr_code: string | null;
  payee_name: string | null;
  notes: string | null;
  uploaded_by: string | null;
  upload_date: string;
  submitted_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  our_bank_account_id: string | null;
  presented_date: string | null;
  cleared_date: string | null;
  bounce_reason: string | null;
  extraction_source: string;
  created_at: string;
};

export type UpiMapping = {
  id: string;
  upi_id: string;
  dealer_name: string;
  firm: string;
  alt_dealer: string | null;
  review: string | null;
  created_at: string;
};

/**
 * Payer bank account → dealer, per firm. HDFC masks the payer's UPI ID in
 * statements but not their account number, so this is what recognises a payer
 * once their UPI ID is hidden. See src/lib/upi-match.ts.
 */
export type UpiPayerAccount = {
  id: string;
  firm: string;
  payer_account: string;
  dealer_name: string;
  /** manual (confirmed on the reconcile screen) | statement (learned) | bulk (file upload) | tally (imported from the Tally bank book) */
  source: string;
  sample_vpa: string | null;
  created_at: string;
};

/**
 * Interview pipeline. A candidate starts at `new` and moves once: either
 * shortlisted for the next round, or rejected. Kept to three states on purpose
 * — round tracking and offers are a different, larger problem.
 */
export type CandidateStatus = "new" | "shortlisted" | "rejected";

export type Candidate = {
  id: string;
  full_name: string;
  reference: string | null;
  phone: string | null;
  position: string | null;
  /** Which area/territory the candidate applied for. */
  area: string | null;
  status: CandidateStatus;
  /** Original filename, shown to the user; the stored path is never exposed. */
  resume_name: string | null;
  resume_path: string | null;
  resume_mime: string | null;
  resume_size: number | null;
  notes: string | null;
  decision_reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_by: string | null;
  created_at: string;
};

/**
 * Notes from one interview round. Multiple notes per round are allowed on
 * purpose — two interviewers in the same round each record their own, rather
 * than overwriting one shared field.
 */
export type RoundOutcome = "pending" | "pass" | "fail";

export type InterviewRound = {
  id: string;
  candidate_id: string;
  round_no: number;
  round_name: string | null;
  outcome: RoundOutcome;
  notes: string;
  interviewer: string | null;
  interviewed_on: string | null;
  created_by: string | null;
  created_at: string;
};

export const ROUND_OUTCOME_META: Record<
  RoundOutcome,
  { label: string; tone: "neutral" | "ok" | "danger" }
> = {
  pending: { label: "Pending", tone: "neutral" },
  pass: { label: "Passed", tone: "ok" },
  fail: { label: "Did not pass", tone: "danger" },
};

export const CANDIDATE_STATUS_META: Record<
  CandidateStatus,
  { label: string; tone: "info" | "ok" | "danger" }
> = {
  new: { label: "New", tone: "info" },
  shortlisted: { label: "Shortlisted", tone: "ok" },
  rejected: { label: "Rejected", tone: "danger" },
};

// The manager-editable fields (mirrors apply_cheque_fields in migration 0015).
export type ChequeFields = {
  cheque_number?: string;
  cheque_date?: string;
  received_date?: string;
  amount?: string;
  amount_in_words?: string;
  dealer_name?: string;
  bank_name?: string;
  branch?: string;
  ifsc?: string;
  account_number?: string;
  micr_code?: string;
  payee_name?: string;
  notes?: string;
};

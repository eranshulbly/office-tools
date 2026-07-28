export type Role = "admin" | "manager";

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

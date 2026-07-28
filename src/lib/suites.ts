import type { Role } from "@/lib/types";

/**
 * Two-level information architecture:
 *
 *   Home ("/")  →  SUITES (products: HR System, Payroll, Cheque Reconciliation…)
 *   Suite page  →  FEATURES within that suite (Attendance, Workers, Runs, …)
 *
 * Adding a new product later = add one SUITE here (and its FEATURES). The home
 * grid, the suite landing pages, and the in-app nav all derive from this file.
 * Access is still enforced for real by database RLS; this only shapes the UI.
 */

export type Accent = "emerald" | "violet" | "sky" | "amber";

export type Suite = {
  key: string;
  title: string;
  description: string;
  icon: string;
  accent: Accent;
  comingSoon?: boolean;
};

export type Feature = {
  key: string;
  title: string;
  description: string;
  href: string;
  icon: string;
  roles: Role[];
  suites: string[];
};

export const SUITES: Suite[] = [
  {
    key: "hr",
    title: "HR System",
    description: "Attendance, employees, work calendar, and day-to-day approvals.",
    icon: "👥",
    accent: "emerald",
  },
  {
    key: "payroll",
    title: "Payroll",
    description: "Monthly salary runs, disbursal, advances, and reconciliation.",
    icon: "💰",
    accent: "violet",
  },
  {
    key: "cheque",
    title: "Cheque Reconciliation",
    description: "Capture dealer cheques and track them to passed or bounced.",
    icon: "🏦",
    accent: "sky",
  },
  {
    key: "upi",
    title: "UPI Reconciliation",
    description: "Map dealer UPI IDs and label bank-statement transactions by dealer.",
    icon: "📲",
    accent: "amber",
  },
];

export const FEATURES: Feature[] = [
  // ── HR System ──
  { key: "dashboard", title: "Overview", description: "Today's punches, device health, exceptions.", href: "/dashboard", icon: "📊", roles: ["admin", "manager"], suites: ["hr"] },
  { key: "attendance", title: "Attendance", description: "Daily grid by employee, raw punches, recompute.", href: "/attendance", icon: "🕔", roles: ["admin"], suites: ["hr"] },
  { key: "calendar", title: "Work calendar", description: "Working / closed / extra / swapped days.", href: "/calendar", icon: "🗓️", roles: ["admin"], suites: ["hr"] },
  { key: "adjustments", title: "Adjustments", description: "Request a forgot-punch correction.", href: "/adjustments", icon: "✏️", roles: ["manager"], suites: ["hr"] },
  { key: "workers", title: "Employees", description: "People, PINs, salary, photos & ID proof.", href: "/workers", icon: "👷", roles: ["admin", "manager"], suites: ["hr"] },
  { key: "device-pins", title: "Device PINs", description: "Map employees to the attendance terminal's User IDs.", href: "/workers/pins", icon: "🔢", roles: ["admin"], suites: ["hr"] },
  { key: "approvals", title: "Approvals", description: "Adjustment requests and after-10 PM late arrivals.", href: "/approvals", icon: "✅", roles: ["admin"], suites: ["hr"] },
  { key: "groups", title: "Employee groups", description: "Define groups and assign employees.", href: "/groups", icon: "🏷️", roles: ["admin"], suites: ["hr"] },
  { key: "managers", title: "Managers", description: "Create managers and set which groups they disburse.", href: "/managers", icon: "🧑‍💼", roles: ["admin"], suites: ["hr"] },
  { key: "settings", title: "Settings", description: "All business-rule thresholds.", href: "/settings", icon: "⚙️", roles: ["admin"], suites: ["hr"] },
  { key: "audit", title: "Audit log", description: "Every decision, filterable.", href: "/audit", icon: "📜", roles: ["admin"], suites: ["hr"] },

  // ── Payroll ──
  { key: "payroll", title: "Salary runs", description: "Compute, approve, per-employee breakdown, reconcile.", href: "/payroll", icon: "🧾", roles: ["admin"], suites: ["payroll"] },
  { key: "advance-approvals", title: "Advance approvals", description: "Pending advance requests with balance context.", href: "/advance-approvals", icon: "✅", roles: ["admin"], suites: ["payroll"] },
  { key: "advances", title: "Advances", description: "Request advances, record cash handover.", href: "/advances", icon: "💵", roles: ["manager"], suites: ["payroll"] },
  { key: "disburse", title: "Disburse", description: "Mark approved salary lines paid.", href: "/disburse", icon: "🪙", roles: ["admin", "manager"], suites: ["payroll"] },
  { key: "statements", title: "Employee ledger", description: "Per-employee salary & advance transactions with running balance.", href: "/statements", icon: "📒", roles: ["admin"], suites: ["payroll"] },

  // ── Cheque Reconciliation ──
  { key: "cheques", title: "Cheques", description: "Upload/enter dealer cheques and track their status.", href: "/cheques", icon: "🧾", roles: ["admin", "manager"], suites: ["cheque"] },
  { key: "cheque-recon", title: "Reconciliation", description: "Present to bank, mark passed/bounced, status dashboard.", href: "/cheques/reconciliation", icon: "🏦", roles: ["admin"], suites: ["cheque"] },
  { key: "cheque-ledger", title: "Auto-reconcile (ledger)", description: "Upload a bank statement to auto-mark cheques passed or bounced.", href: "/cheques/ledger", icon: "📥", roles: ["admin"], suites: ["cheque"] },
  { key: "cheque-banks", title: "Bank accounts", description: "Manage your own bank accounts cheques are presented to.", href: "/cheques/bank-accounts", icon: "🏛️", roles: ["admin"], suites: ["cheque"] },

  // ── UPI Reconciliation (admin only) ──
  { key: "upi-reconcile", title: "Reconcile statement", description: "Upload a bank statement and label transactions by dealer.", href: "/upi/reconcile", icon: "📄", roles: ["admin"], suites: ["upi"] },
  { key: "upi-mappings", title: "Dealer UPI IDs", description: "Map each dealer's UPI ID to their name.", href: "/upi", icon: "🔗", roles: ["admin"], suites: ["upi"] },
];

export const ACCENT: Record<Accent, { fg: string; soft: string }> = {
  emerald: { fg: "var(--color-accent-emerald)", soft: "#ecfdf5" },
  violet: { fg: "var(--color-accent-violet)", soft: "#f5f3ff" },
  sky: { fg: "var(--color-accent-sky)", soft: "#f0f9ff" },
  amber: { fg: "var(--color-accent-amber)", soft: "#fffbeb" },
};

// Suites gated behind the per-user `full_access` flag. A manager WITHOUT full
// access sees these as "coming soon" (Cheque-only); admins always have access.
export const GATED_SUITES = ["hr", "payroll"];

/** Is a suite "coming soon" for this user (global flag, or gated + no access)? */
export function suiteComingSoon(suite: Suite, role: Role, fullAccess: boolean): boolean {
  if (suite.comingSoon) return true;
  if (GATED_SUITES.includes(suite.key) && role !== "admin" && !fullAccess) return true;
  return false;
}

export function featuresForSuite(suiteKey: string, role: Role, fullAccess = false): Feature[] {
  const suite = suiteByKey(suiteKey);
  if (suite && suiteComingSoon(suite, role, fullAccess)) return [];
  return FEATURES.filter((f) => f.suites.includes(suiteKey) && f.roles.includes(role));
}

/**
 * Where a suite tile / breadcrumb should land: straight at the suite's first
 * feature for this role (its first tab), skipping any intermediate page.
 * Falls back to the suite landing route only if the role has no features.
 */
export function firstFeatureHref(suiteKey: string, role: Role, fullAccess = false): string {
  const features = featuresForSuite(suiteKey, role, fullAccess);
  return features[0]?.href ?? `/s/${suiteKey}`;
}

/** Suites visible to a user: any with ≥1 feature for them, plus "coming soon" ones. */
export function suitesForRole(role: Role, fullAccess = false): Suite[] {
  return SUITES.filter(
    (s) => suiteComingSoon(s, role, fullAccess) || featuresForSuite(s.key, role, fullAccess).length > 0
  );
}

export function suiteByKey(key: string): Suite | undefined {
  return SUITES.find((s) => s.key === key);
}

/** The suite that owns the current path (longest matching feature href wins). */
export function suiteForPath(pathname: string): Suite | undefined {
  if (pathname.startsWith("/s/")) {
    return suiteByKey(pathname.split("/")[2] ?? "");
  }
  let best: Feature | undefined;
  for (const f of FEATURES) {
    if (pathname === f.href || pathname.startsWith(f.href + "/")) {
      if (!best || f.href.length > best.href.length) best = f;
    }
  }
  return best ? suiteByKey(best.suites[0]) : undefined;
}

export function featureForPath(pathname: string): Feature | undefined {
  let best: Feature | undefined;
  for (const f of FEATURES) {
    if (pathname === f.href || pathname.startsWith(f.href + "/")) {
      if (!best || f.href.length > best.href.length) best = f;
    }
  }
  return best;
}

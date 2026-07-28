/**
 * Bank-ledger cheque reconciliation.
 *
 * Parses an HDFC current-account statement (the inward cheque-deposit account)
 * and works out which of our outstanding cheques PASSED or BOUNCED — without
 * ever mislabelling one. The guiding rule from the business: it is fine to leave
 * a cheque unmatched, but a WRONG outcome must never be applied. Every decision
 * below is therefore conservative — anything ambiguous is skipped, not guessed.
 *
 * Ledger shape (one event per row):
 *   CHQ DEP  - CTS CLG1 - BAREILLY: <DRAWER NAME> :<BANK>   → a cheque we banked (Deposit Amt)
 *   CHQ DEP RET- ... <REASON> ...                            → that cheque bounced (Withdrawal Amt)
 * The return row carries the reason but NOT the drawer name; the drawer comes
 * from the deposit. Chq./Ref.No. on a CHQ row is the drawer's cheque number,
 * zero-padded to 16 digits (strip leading zeros before matching).
 *
 * Match key: cheque number + amount (the hard key — unique for ~99% of rows).
 * A number+amount that maps to more than one drawer is AMBIGUOUS → skipped.
 * When the row DOES name a party it must be fuzzy-compatible with our dealer,
 * else the number+amount coincidentally hit someone else → skipped. Many rows
 * carry no party at all ("CHQ DEP - CTS CLG1 - BAREILLY"); those fall back to
 * number+amount alone, which stays safe because we additionally refuse the match
 * when two of OUR cheques share that same number and amount.
 * Outcome: net = #deposits − #returns for the (number+amount+drawer) cheque.
 * net > 0 → eventually cleared (passed); net = 0 → all came back (bounced).
 */

export type LedgerDeposit = { chqNo: string; amount: number; drawer: string; bank: string; date: string; row: number };
export type LedgerReturn = { chqNo: string; amount: number; date: string; reason: string; row: number };
export type ParsedLedger = {
  ok: boolean;
  error?: string;
  deposits: LedgerDeposit[];
  returns: LedgerReturn[];
};

export type SystemCheque = {
  id: string;
  cheque_number: string | null;
  amount: number | null;
  dealer_name: string | null;
  cheque_date: string | null;
  payee_name: string | null;
  status: string;
};

export type Outcome = "passed" | "bounced";
export type SkipReason = "not_found" | "ambiguous" | "name_mismatch" | "bad_data" | "other_firm";

export type MatchResult = {
  cheque: SystemCheque;
  outcome: Outcome | null; // null → skipped (see skip)
  skip?: SkipReason;
  note: string; // human explanation (bounce reason, or why skipped)
  drawer?: string;
  /**
   * True when the statement carried a party name and it matched our dealer.
   * False when the statement row had no name and we matched on cheque number +
   * amount alone (still safe — that pairing must be unique on both sides).
   */
  nameVerified?: boolean;
  presentedDate?: string; // ISO — earliest deposit
  outcomeDate?: string; // ISO — clear/return date
  deposits?: number;
  returns?: number;
};

// ── helpers ──────────────────────────────────────────────────────────────────

function num(v: unknown): number {
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Digits only, leading zeros stripped: "0000000000797955" → "797955". */
export function normChequeNo(v: string | null | undefined): string {
  return String(v ?? "").replace(/\D/g, "").replace(/^0+/, "");
}

/** dd/mm/yy(yy) → ISO yyyy-mm-dd (2-digit year assumed 20xx). null if unparseable. */
export function ledgerDateToIso(s: string | null | undefined): string | null {
  const m = String(s ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const d = m[1].padStart(2, "0");
  const mo = m[2].padStart(2, "0");
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${mo}-${d}`;
}

const amountKey = (a: number) => a.toFixed(2);
const matchKey = (chqNo: string, amount: number) => `${chqNo}|${amountKey(amount)}`;

// Generic trade words that don't identify a specific dealer — ignored when
// comparing names so "Ramesh Auto Mobiles" ≠ "Suresh Auto Mobiles".
const NAME_STOPWORDS = new Set([
  "AUTO", "AUTOS", "MOBILE", "MOBILES", "AUTOMOBILE", "AUTOMOBILES", "MOTOR", "MOTORS",
  "SPARE", "SPARES", "PART", "PARTS", "TRADER", "TRADERS", "TRADING", "AND", "THE", "OF",
  "CO", "COMPANY", "PVT", "PRIVATE", "LTD", "LIMITED", "WORKS", "WORKSHOP", "MACHINERY",
  "STORE", "STORES", "ENTERPRISE", "ENTERPRISES", "AGENCY", "AGENCIES", "SONS", "BROS",
  "BROTHERS", "INDIA", "CYCLE", "CYCLES", "CENTER", "CENTRE", "SALES", "SERVICE", "SERVICES",
  "MS", "M/S", "NEW",
]);

function nameTokens(s: string | null | undefined): string[] {
  return String(s ?? "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * Fuzzy name compatibility, tolerant of the ledger's messy/truncated spellings
 * but requiring a real distinctive-token overlap. Both names must contribute at
 * least one non-generic token, and at least half of the smaller distinctive set
 * must match. Missing/generic-only names → not compatible (so we skip, safely).
 */
export function namesCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = nameTokens(a).filter((t) => !NAME_STOPWORDS.has(t));
  const db = nameTokens(b).filter((t) => !NAME_STOPWORDS.has(t));
  if (da.length === 0 || db.length === 0) return false;
  const setA = new Set(da);
  const setB = new Set(db);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const minSize = Math.min(setA.size, setB.size);
  return inter >= 1 && inter >= Math.ceil(minSize * 0.5);
}

// ── parsing ──────────────────────────────────────────────────────────────────

/** Locate a column by matching its header cell text. */
function findCol(header: string[], test: (h: string) => boolean): number {
  return header.findIndex((h) => test(String(h ?? "").trim().toLowerCase()));
}

/** Parse a statement (array-of-arrays from SheetJS) into deposit/return events. */
export function parseLedger(rows: string[][]): ParsedLedger {
  let headerIdx = rows.findIndex(
    (r) => Array.isArray(r) && r.some((c) => String(c).trim().toLowerCase() === "narration")
  );
  if (headerIdx < 0) return { ok: false, error: "Couldn't find the statement header (no 'Narration' column).", deposits: [], returns: [] };

  const header = (rows[headerIdx] ?? []).map((c) => String(c ?? "").trim());
  const iNarr = findCol(header, (h) => h.includes("narration"));
  const iChq = findCol(header, (h) => h.includes("chq") || (h.includes("ref") && h.includes("no")));
  const iWd = findCol(header, (h) => h.includes("withdrawal"));
  const iDep = findCol(header, (h) => h.includes("deposit"));
  let iDate = findCol(header, (h) => h === "date");
  if (iDate < 0) iDate = findCol(header, (h) => h.includes("date") && !h.includes("value"));

  if (iNarr < 0 || iChq < 0 || iWd < 0 || iDep < 0) {
    return { ok: false, error: "Statement is missing expected columns (Narration / Chq.Ref.No / Withdrawal / Deposit).", deposits: [], returns: [] };
  }

  const deposits: LedgerDeposit[] = [];
  const returns: LedgerReturn[] = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = (rows[i] ?? []).map((c) => String(c ?? ""));
    const narr = (r[iNarr] ?? "").trim();
    if (!narr) continue;
    if (/end of statement/i.test(narr)) break;
    if (/^\*+$/.test(narr)) continue; // separator rows

    const isChq = /\bCHQ\b/i.test(narr);
    if (!isChq) continue;
    const isReturn = /\bRET\b|RET[-\s]|RETURN|RTN/i.test(narr);

    const chqNo = normChequeNo(r[iChq]);
    if (!chqNo) continue;
    const date = ledgerDateToIso(r[iDate] ?? "") ?? "";
    const wd = num(r[iWd]);
    const dep = num(r[iDep]);

    if (isReturn && wd > 0) {
      returns.push({ chqNo, amount: wd, date, reason: returnReason(narr), row: i });
    } else if (dep > 0) {
      const { drawer, bank } = drawerFromNarration(narr);
      deposits.push({ chqNo, amount: dep, drawer, bank, date, row: i });
    }
  }

  return { ok: true, deposits, returns };
}

/** "CHQ DEP - CTS CLG1 - BAREILLY: <DRAWER> :<BANK>" → drawer + bank. */
export function drawerFromNarration(narr: string): { drawer: string; bank: string } {
  const parts = narr.split(":");
  // parts[0] = "...BAREILLY", parts[1] = drawer, parts[2..] = bank
  const drawer = (parts[1] ?? "").trim();
  const bank = parts.slice(2).join(":").trim();
  return { drawer, bank };
}

/** Pull the return reason out of a "...RET-<REASON><ref>" narration. */
export function returnReason(narr: string): string {
  const m = narr.match(/RE?T(?:URN)?\s*[-:]?\s*(.+)$/i);
  let reason = (m ? m[1] : narr).trim();
  // Drop a leading cheque/reference number ("0000...36553-" or "36553:") …
  reason = reason.replace(/^[0-9]{4,}[-\s:]+/, "").trim();
  // … and a trailing reference token. It must CONTAIN A DIGIT — plain words can
  // be long too ("INSUFFICIENT" is 12 chars) and must not be mistaken for a ref.
  reason = reason.replace(/[\s:-]+(?=[A-Z0-9]*\d)[A-Z0-9]{10,}\s*$/i, "").trim();
  return reason || narr.trim();
}

const KNOWN_FIRM_RE = /(anmol|om\s*market)/i;
function firmKey(s: string | null | undefined): string {
  return String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ── matching ─────────────────────────────────────────────────────────────────

/**
 * Reconcile our outstanding cheques against the parsed ledger. `firm` is the
 * firm that owns this bank account (its payee) — a cheque whose payee is the
 * OTHER known firm is skipped so one firm's ledger never settles the other's.
 */
export function matchCheques(ledger: ParsedLedger, cheques: SystemCheque[], firm: string): MatchResult[] {
  // Group deposits + returns by (chequeNo + amount).
  const groups = new Map<string, { deposits: LedgerDeposit[]; returns: LedgerReturn[] }>();
  const groupFor = (k: string) => {
    let g = groups.get(k);
    if (!g) { g = { deposits: [], returns: [] }; groups.set(k, g); }
    return g;
  };
  for (const d of ledger.deposits) groupFor(matchKey(d.chqNo, d.amount)).deposits.push(d);
  for (const rt of ledger.returns) groupFor(matchKey(rt.chqNo, rt.amount)).returns.push(rt);

  const firmK = firmKey(firm);

  // Our own cheques sharing a number+amount. Used to refuse a match we could not
  // tell apart — without a party name that pairing is all we have to go on.
  const candidates = cheques.filter(
    (c) =>
      c.cheque_number &&
      c.amount != null &&
      c.amount > 0 &&
      !(firmKey(c.payee_name) && KNOWN_FIRM_RE.test(c.payee_name ?? "") && firmKey(c.payee_name) !== firmK)
  );
  const byKey = new Map<string, SystemCheque[]>();
  for (const c of candidates) {
    const k = matchKey(normChequeNo(c.cheque_number), c.amount as number);
    byKey.set(k, [...(byKey.get(k) ?? []), c]);
  }

  return cheques.map((c): MatchResult => {
    if (!c.cheque_number || c.amount == null || !(c.amount > 0)) {
      return { cheque: c, outcome: null, skip: "bad_data", note: "Cheque has no number/amount to match on." };
    }
    // Firm guard: only skip when the cheque clearly belongs to the OTHER firm.
    const payeeK = firmKey(c.payee_name);
    if (payeeK && KNOWN_FIRM_RE.test(c.payee_name ?? "") && payeeK !== firmK) {
      return { cheque: c, outcome: null, skip: "other_firm", note: `Payee is ${c.payee_name}, not ${firm}.` };
    }

    const key = matchKey(normChequeNo(c.cheque_number), c.amount);
    const grp = groups.get(key);
    if (!grp || (grp.deposits.length === 0 && grp.returns.length === 0)) {
      return { cheque: c, outcome: null, skip: "not_found", note: "No matching cheque deposit in this statement." };
    }

    const siblings = byKey.get(key) ?? [];

    // Return WITHOUT a deposit: the cheque was banked in an earlier statement
    // period and came back during this one. A return row never carries a party
    // name, so number + amount must identify exactly one of our cheques.
    if (grp.deposits.length === 0) {
      if (siblings.length > 1) {
        return { cheque: c, outcome: null, skip: "ambiguous", note: "A return matches this number and amount, but so do two of your cheques." };
      }
      const last = [...grp.returns].sort((a, b) => a.date.localeCompare(b.date)).slice(-1)[0];
      return {
        cheque: c,
        outcome: "bounced",
        note: `${last?.reason || "Returned by the bank."} (Returned in this statement; the deposit predates it.)`,
        nameVerified: false,
        outcomeDate: last?.date || undefined,
        deposits: 0,
        returns: grp.returns.length,
      };
    }

    // Distinct NAMED drawers on this number+amount. Many statement rows carry no
    // party at all ("CHQ DEP - CTS CLG1 - BAREILLY"), so absence is normal.
    const named = grp.deposits.map((d) => d.drawer).filter((n) => nameTokens(n).length > 0);
    const distinctNamed = new Set(named.map((n) => nameTokens(n).join(" ")));
    if (distinctNamed.size > 1) {
      return { cheque: c, outcome: null, skip: "ambiguous", note: "Number + amount matches more than one party in the statement." };
    }

    let drawer: string | undefined;
    let nameVerified = false;

    if (distinctNamed.size === 1) {
      // The statement names a party — it must agree with our dealer.
      drawer = named[0];
      if (!namesCompatible(drawer, c.dealer_name)) {
        return { cheque: c, outcome: null, skip: "name_mismatch", note: `Number + amount matched, but the statement party "${drawer}" doesn't match "${c.dealer_name ?? ""}".`, drawer };
      }
      nameVerified = true;
      // If several of our cheques share this key and more than one fits the
      // name, we cannot say which one the statement row refers to.
      if (siblings.filter((s) => namesCompatible(drawer, s.dealer_name)).length > 1) {
        return { cheque: c, outcome: null, skip: "ambiguous", note: "Two of your cheques share this number, amount and party — settle these by hand.", drawer };
      }
    } else {
      // No party on the statement: fall back to cheque number + amount alone.
      // Safe only while that pairing identifies exactly one of our cheques.
      if (siblings.length > 1) {
        return { cheque: c, outcome: null, skip: "ambiguous", note: "The statement row has no party name and two of your cheques share this number and amount.", drawer: undefined };
      }
    }

    const D = grp.deposits.length;
    const R = grp.returns.length;
    const net = D - R;
    if (net < 0) {
      return { cheque: c, outcome: null, skip: "ambiguous", note: "More returns than deposits for this cheque — needs manual review.", drawer, deposits: D, returns: R };
    }
    const unverified = nameVerified ? "" : " Matched on cheque number + amount (the statement row carries no party name).";

    const presentedDate = grp.deposits.map((d) => d.date).filter(Boolean).sort()[0] || undefined;
    if (net > 0) {
      const outcomeDate = grp.deposits.map((d) => d.date).filter(Boolean).sort().slice(-1)[0] || undefined;
      const base = R > 0 ? `Cleared (deposited ${D}×, returned ${R}×, net cleared).` : "Cleared — no return in the statement.";
      return { cheque: c, outcome: "passed", note: base + unverified, drawer, nameVerified, presentedDate, outcomeDate, deposits: D, returns: R };
    }
    // net === 0 → every deposit was returned → bounced (use the latest return).
    const lastReturn = [...grp.returns].sort((a, b) => a.date.localeCompare(b.date)).slice(-1)[0];
    return {
      cheque: c,
      outcome: "bounced",
      note: (lastReturn?.reason || "Returned by the bank.") + unverified,
      drawer,
      nameVerified,
      presentedDate,
      outcomeDate: lastReturn?.date || undefined,
      deposits: D,
      returns: R,
    };
  });
}

// Relative, not "@/lib/upi": vitest has no path alias, and this module is unit-tested.
import { normUpi, isMaskedVpa } from "./upi";

/**
 * Who paid this UPI credit? Scores every statement line against what we know
 * and returns a confirmed dealer, ranked suggestions, or nothing.
 *
 * Since 14 Oct 2026 HDFC masks the payer's VPA ("******3148@PTAXIS": same
 * length, last 4 characters and the @handle visible) but still prints the
 * payer's bank account number in full. So, strongest evidence first:
 *
 *   CONFIRMED (100)
 *     1. exact VPA hit on a mapping with a blank `review`
 *     2. payer account saved against a dealer (upi_payer_accounts)
 *     3. payer account that, elsewhere in THIS statement, paid from an
 *        unmasked VPA we map — e.g. an old statement, or the first days of a
 *        month before masking began
 *
 *   SUGGESTED (scored, never confirmed — a person checks these)
 *     - direct evidence about this payer, if any — then nothing else is tried:
 *       exact VPA on a flagged ("Ambiguous - verify") mapping, or a payer
 *       account seen paying from one; each with its alt dealer as runner-up
 *     - unmasked VPA: same id on another app, or same number with another -N
 *     - masked VPA: fits a mapped VPA's length and visible characters, scored
 *       up for the same @handle / same app and for distinctive letters
 *   Flagged mappings join fuzzy matching 10 points down, their alt dealer 30
 *   down. Placeholder rows ("(as per details)") never do.
 *
 * Each dealer keeps its best piece of evidence. When several dealers compete,
 * each score is scaled by its share of the total (score² / Σscore), so two
 * equally good 80s become 40% each — "could be either, check it" — while a
 * lone 80 stays 80.
 */

export type VpaMapping = {
  upi_id: string;
  dealer_name: string;
  review?: string | null;
  alt_dealer?: string | null;
};
export type AccountMapping = { payer_account: string; dealer_name: string };
export type StatementLine = { vpa: string | null; account: string | null };

export type Candidate = { dealer: string; score: number; reason: string };
export type MatchStatus = "confirmed" | "suggested" | "unmapped" | "not-upi";
export type Match = {
  status: MatchStatus;
  /** Confirmed dealer, or the best suggestion. */
  dealer: string | null;
  /** 0–100. 100 only for confirmed. */
  score: number;
  reason: string;
  /** Every candidate, best first (includes the top one). */
  candidates: Candidate[];
};

/**
 * A payer account this statement teaches us. `flagged` when the VPA it paid
 * from is on an "Ambiguous - verify" mapping: then it only suggests, and is not
 * offered for saving.
 */
export type LearnedAccount = {
  payer_account: string;
  dealer_name: string;
  sample_vpa: string;
  flagged: boolean;
  alt: string | null;
};

type Entry = {
  vpa: string; local: string; base: string; handle: string;
  dealer: string; alt: string | null;
  /** Points off fuzzy scores: 0 for a clean mapping, more for a flagged one. */
  penalty: number;
};

/**
 * Placeholder rows ("(as per details)" / "Placeholder - classify in Tally")
 * name no real dealer; letting them into fuzzy matching would suggest nonsense.
 */
function isPlaceholder(dealer: string, review: string): boolean {
  return /^\(.*\)$/.test(dealer.trim()) || /placeholder/i.test(review);
}

export type MatchIndex = {
  byVpa: Map<string, { dealer: string; confirmed: boolean; review: string; alt: string | null; placeholder: boolean }>;
  byAccount: Map<string, string>;
  learned: Map<string, LearnedAccount>;
  entries: Entry[];
};

/** UPI apps share several bank handles; a payer usually sticks to one app. */
const APP_OF_HANDLE: Record<string, string> = {
  ybl: "PhonePe", ibl: "PhonePe", axl: "PhonePe",
  paytm: "Paytm", ptyes: "Paytm", ptaxis: "Paytm", pthdfc: "Paytm", ptsbi: "Paytm",
  okaxis: "Google Pay", oksbi: "Google Pay", okhdfcbank: "Google Pay", okicici: "Google Pay",
  nyes: "Navi", naviaxis: "Navi",
  superyes: "super.money",
};
const appOf = (handle: string) => APP_OF_HANDLE[handle] ?? null;

/** "9675615714-3" → "9675615714"; long digit runs keep their last 10 (drops a 91 prefix). */
function baseOf(local: string): string {
  const b = local.replace(/-\d+$/, "");
  return /^\d{11,}$/.test(b) ? b.slice(-10) : b;
}

function split(vpa: string): { local: string; handle: string } {
  const at = vpa.lastIndexOf("@");
  return at < 0 ? { local: vpa, handle: "" } : { local: vpa.slice(0, at), handle: vpa.slice(at + 1) };
}

/** Build lookups for one firm, learning payer accounts from this statement's unmasked lines. */
export function buildMatchIndex(
  vpas: VpaMapping[],
  accounts: AccountMapping[],
  lines: StatementLine[] = []
): MatchIndex {
  const byVpa: MatchIndex["byVpa"] = new Map();
  const entries: Entry[] = [];
  for (const m of vpas) {
    const key = normUpi(m.upi_id);
    if (!key || isMaskedVpa(key)) continue;
    const review = String(m.review ?? "").trim();
    const alt = String(m.alt_dealer ?? "").trim() || null;
    const placeholder = isPlaceholder(m.dealer_name, review);
    byVpa.set(key, { dealer: m.dealer_name, confirmed: !review, review, alt, placeholder });
    // Flagged ("Ambiguous - verify") mappings still name the likely dealer, so
    // they feed fuzzy matching at a discount; placeholders name nobody.
    if (!placeholder) {
      const { local, handle } = split(key);
      entries.push({ vpa: key, local, base: baseOf(local), handle, dealer: m.dealer_name, alt, penalty: review ? 10 : 0 });
    }
  }

  const byAccount = new Map<string, string>();
  for (const a of accounts) byAccount.set(a.payer_account.trim(), a.dealer_name);

  // account → dealers seen paying from a mapped, unmasked VPA in this statement
  const seen = new Map<string, { dealers: Set<string>; vpa: string; clean: boolean; alt: string | null }>();
  for (const l of lines) {
    if (!l.account || !l.vpa || isMaskedVpa(l.vpa) || byAccount.has(l.account)) continue;
    const hit = byVpa.get(normUpi(l.vpa));
    if (!hit || hit.placeholder) continue;
    const s = seen.get(l.account) ?? { dealers: new Set<string>(), vpa: normUpi(l.vpa), clean: false, alt: null };
    s.dealers.add(hit.dealer);
    if (hit.confirmed && !s.clean) { s.clean = true; s.vpa = normUpi(l.vpa); } // show a clean mapping as the example
    if (!hit.confirmed) s.alt = s.alt ?? hit.alt;
    seen.set(l.account, s);
  }
  const learned = new Map<string, LearnedAccount>();
  for (const [acct, s] of seen) {
    // An account that paid as two different dealers is shared — learn nothing from it.
    if (s.dealers.size === 1) {
      learned.set(acct, {
        payer_account: acct, dealer_name: [...s.dealers][0], sample_vpa: s.vpa,
        flagged: !s.clean, alt: s.clean ? null : s.alt,
      });
    }
  }

  return { byVpa, byAccount, learned, entries };
}

const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** "******3148" → /^......3148$/ */
const maskRegex = (masked: string) =>
  new RegExp("^" + masked.split("").map((c) => (c === "*" ? "." : esc(c))).join("") + "$");

export function matchLine(line: StatementLine, idx: MatchIndex): Match {
  if (!line.vpa) return { status: "not-upi", dealer: null, score: 0, reason: "", candidates: [] };
  const key = normUpi(line.vpa);
  const masked = isMaskedVpa(key);
  const acct = line.account;

  const confirmed = (dealer: string, reason: string): Match => ({
    status: "confirmed", dealer, score: 100, reason, candidates: [{ dealer, score: 100, reason }],
  });

  const hit = masked ? undefined : idx.byVpa.get(key);
  if (hit?.confirmed) return confirmed(hit.dealer, "Exact UPI ID match");
  if (acct && idx.byAccount.has(acct)) return confirmed(idx.byAccount.get(acct)!, `Saved payer account ${acct}`);
  const learnt = acct ? idx.learned.get(acct) : undefined;
  if (learnt && !learnt.flagged) {
    return confirmed(learnt.dealer_name, `Same payer account paid from ${learnt.sample_vpa} in this statement`);
  }

  // Suggestions: best evidence per dealer.
  const best = new Map<string, Candidate>();
  const add = (dealer: string, score: number, reason: string) => {
    const s = Math.max(0, Math.min(90, Math.round(score)));
    const cur = best.get(dealer);
    if (!cur || s > cur.score) best.set(dealer, { dealer, score: s, reason });
  };

  const { local, handle } = split(key);
  const app = appOf(handle);
  const addEntry = (e: Entry, score: number, why: string) => {
    add(e.dealer, score - e.penalty, e.penalty ? `${why} (flagged mapping)` : why);
    if (e.alt) add(e.alt, score - 30, `${why} (alternate dealer)`);
  };

  // Direct evidence about THIS payer (their exact VPA, or their account number)
  // outranks look-alike VPAs of other payers, so when we have it, we stop there.
  if (hit && !hit.placeholder) {
    add(hit.dealer, 75, `Mapped, but flagged: ${hit.review}`);
    if (hit.alt) add(hit.alt, 40, "Alternate dealer on a flagged mapping");
  } else if (hit) {
    add(hit.dealer, 30, `Placeholder mapping: ${hit.review}`);
  } else if (learnt) {
    add(learnt.dealer_name, 75, `Same payer account paid from ${learnt.sample_vpa} (flagged mapping) in this statement`);
    if (learnt.alt) add(learnt.alt, 40, "Alternate dealer on that flagged mapping");
  } else if (!masked) {
    const base = baseOf(local);
    for (const e of idx.entries) {
      if (e.local === local) {
        addEntry(e, app && appOf(e.handle) === app ? 85 : 80, `Same ID on another handle: ${e.vpa}`);
      } else if (base.length >= 6 && e.base === base) {
        addEntry(e, 75, `Same number/username, different suffix: ${e.vpa}`);
      }
    }
  } else {
    const visible = local.replace(/\*/g, "");
    if (visible) {
      const full = maskRegex(local);
      // "********95-3" may be the same phone as a mapped "…95-2": compare without the -N.
      const suf = local.match(/^(.*?)(-\d+)$/);
      const baseRe = suf && /[^*]/.test(suf[1]) ? maskRegex(suf[1]) : null;
      const core = (suf ? suf[1] : local).replace(/\*/g, "");
      const distinctive = /[a-z.]/.test(visible);

      for (const e of idx.entries) {
        let score: number;
        let why: string;
        if (full.test(e.local)) {
          score = 55;
          why = `Masked ${key} fits ${e.vpa}`;
        } else if (baseRe && baseRe.test(e.local.replace(/-\d+$/, ""))) {
          score = 35;
          why = `Masked ${key} fits ${e.vpa} (different -N suffix)`;
        } else continue;

        if (e.handle === handle) { score += 25; why += " · same handle"; }
        else if (app && appOf(e.handle) === app) { score += 15; why += ` · same app (${app})`; }
        if (distinctive) score += 10;
        if (core.length < 4) score -= 10;
        addEntry(e, score, why);
      }
    }
  }

  const list = [...best.values()].filter((c) => c.score > 0);
  if (list.length === 0) return { status: "unmapped", dealer: null, score: 0, reason: "", candidates: [] };
  const total = list.reduce((s, c) => s + c.score, 0);
  const candidates = list
    .map((c) => ({ ...c, score: total ? Math.round((c.score * c.score) / total) : 0 }))
    .sort((a, b) => b.score - a.score || a.dealer.localeCompare(b.dealer));
  const top = candidates[0];
  return { status: "suggested", dealer: top.dealer, score: top.score, reason: top.reason, candidates };
}

/** Confidence tier for display. */
export function tierOf(m: Match, minScore: number): "confirmed" | "likely" | "possible" | "unmapped" | "not-upi" {
  if (m.status === "confirmed") return "confirmed";
  if (m.status === "not-upi") return "not-upi";
  if (m.status === "unmapped" || m.score < minScore) return "unmapped";
  return m.score >= 70 ? "likely" : "possible";
}

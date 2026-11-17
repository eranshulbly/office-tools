"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { amountToWords, chequeIdentityKeys } from "@/lib/cheque";
import { requireFirm, getActiveFirm } from "@/lib/firm";
import type { ChequeFields } from "@/lib/types";

export type ChequeActionState = { error?: string; ok?: boolean; count?: number };

/**
 * Identity keys of every cheque already in the system that should block a
 * re-upload — i.e. anything not bounced. A bounced cheque may legitimately be
 * presented again, so it does not block.
 *
 * Shared by the save guard and the live check the upload screen runs, so the
 * two can never disagree about what counts as a duplicate.
 */
async function existingIdentityKeys(): Promise<Set<string>> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("cheques")
    .select("cheque_number, account_number, ifsc, micr_code")
    .neq("status", "bounced");
  const set = new Set<string>();
  for (const c of data ?? []) for (const k of chequeIdentityKeys(c)) set.add(k);
  return set;
}

/**
 * Which of these cheques already exist in the system? Returns their positions.
 *
 * Called by the upload screen as soon as extraction finishes, so duplicates are
 * flagged before the user commits rather than after — the save guard still runs
 * server-side regardless, since a client check is a convenience, not a control.
 */
export async function findKnownDuplicates(list: ChequeFields[]): Promise<number[]> {
  if (!Array.isArray(list) || list.length === 0) return [];
  const existing = await existingIdentityKeys();
  const hits: number[] = [];
  list.forEach((f, i) => {
    const keys = chequeIdentityKeys(clean(f));
    if (keys.length && keys.some((k) => existing.has(k))) hits.push(i);
  });
  return hits;
}

// ── AI extraction via the S9 LLM gateway (Gemini vision) ─────────────────────
// The gateway runs as a localhost Python sidecar; POST /v1/vision returns a
// schema-validated `parsed` object. The image is passed through transiently and
// never stored (extract-and-forget). Failure is non-fatal — the manager types.
const GATEWAY_URL = process.env.CHEQUE_GATEWAY_URL || "http://127.0.0.1:8109";
const OCR_URL = process.env.CHEQUE_OCR_URL || "http://127.0.0.1:8110";

const EXTRACT_PROMPT =
  "You are reading a single scanned INDIAN BANK CHEQUE. Extract the fields into the " +
  "given JSON schema. CONFIDENCE RULE (most important): only fill a field when you are 100% " +
  "CERTAIN of its value (clearly legible and unambiguous). If there is ANY doubt, blur, unclear " +
  "handwriting, overlapping ink, or you would be guessing even slightly, return an EMPTY STRING " +
  "\"\" for that field. Never guess or infer. A blank field is CORRECT and will be entered by " +
  "hand; a wrong or approximate value is NOT acceptable. Be especially strict with amount, " +
  "cheque_number and cheque_date. cheque_number RULE (important): read it ONLY from the MICR " +
  "band — the line of special magnetic-ink digits printed along the very bottom of the cheque. " +
  "The cheque_number is the FIRST group of digits in that MICR band (typically 6 digits, e.g. " +
  "from a band reading \"042156 243026216 714500 29\" the cheque_number is \"042156\"). Return " +
  "exactly those digits, keeping any leading zeros. Do NOT use the \"Cheque No.\" / \"चेक क्र.\" " +
  "box printed elsewhere on the cheque body — that value can differ (e.g. have extra leading " +
  "digits) and is NOT authoritative. If the MICR band's first group is not fully legible, return " +
  "an EMPTY STRING \"\" for cheque_number (never fall back to the printed box). Formatting for " +
  "values you ARE sure of: amount = the figure " +
  "amount as digits only, no commas or " +
  "currency symbol (e.g. \"5000\" or \"5000.50\"); normalise cheque_date to YYYY-MM-DD; " +
  "dealer_name = the drawer / account holder who issued the cheque (the party paying us); " +
  "payee_name = who the cheque is payable to; bank_name = the drawee bank printed on the " +
  "cheque; read the MICR band for micr_code and account_number when printed. " +
  "The image may be rotated or upside down — read the fields as they truly are regardless. " +
  "ALL returned values MUST be in ENGLISH: if any text on the cheque is in Hindi/Devanagari, " +
  "transliterate names into English and translate words into proper English — never return " +
  "Devanagari script. The payee_name is ALWAYS one of exactly two companies: \"Anmol Associates\" " +
  "or \"Om Marketing\" — return whichever it is using that exact spelling. If a field is not " +
  "legible or not present, return an EMPTY STRING \"\" for it. Do not guess.";

// The payee is always one of our two companies; map any read variant (case,
// spacing, extra words like "CO"/"& CO", Hindi transliteration) to the canonical name.
function normalizePayee(raw: string): string {
  const key = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (key.includes("ANMOL")) return "Anmol Associates";
  if (key.includes("MARKET") || key.includes("OMMARKET")) return "Om Marketing";
  return raw.trim();
}

// All fields are plain strings (Gemini structured-output rejects union/null types;
// empty string = "not present"). The gateway validates `parsed` against this same
// schema with Draft2020, and empty strings satisfy `type: string`.
const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    cheque_number: { type: "string" },
    cheque_date: { type: "string" },
    amount: { type: "string" },
    amount_in_words: { type: "string" },
    dealer_name: { type: "string" },
    bank_name: { type: "string" },
    branch: { type: "string" },
    ifsc: { type: "string" },
    account_number: { type: "string" },
    micr_code: { type: "string" },
    payee_name: { type: "string" },
  },
} as const;

const EXTRACT_KEYS: (keyof ChequeFields)[] = [
  "cheque_number", "cheque_date", "amount", "amount_in_words", "dealer_name",
  "bank_name", "branch", "ifsc", "account_number", "micr_code", "payee_name",
];

function normalizeExtracted(parsed: Record<string, unknown>): ChequeFields {
  const out: ChequeFields = {};
  for (const k of EXTRACT_KEYS) {
    const v = parsed[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) out[k] = s;
  }
  if (out.payee_name) out.payee_name = normalizePayee(out.payee_name);
  return out;
}

export type ExtractResult = {
  ok: boolean;
  fields?: ChequeFields;
  source?: "ai" | "ocr";
  provider?: string;
  error?: string;
};

/**
 * AI vision via the gateway. NOT pinned to one provider — the gateway fails over
 * across its vision-capable providers per LLM_ORDER (Gemini first, then the
 * OpenRouter vision model) with quota-aware backoff. Returns null on any failure
 * so the caller drops to OCR.
 */
async function extractViaAI(dataUrl: string): Promise<{ fields: ChequeFields; provider?: string } | null> {
  try {
    const resp = await fetch(`${GATEWAY_URL}/v1/vision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: dataUrl,
        prompt: EXTRACT_PROMPT,
        schema: EXTRACT_SCHEMA,
        schema_name: "Cheque",
        agent: "cheque_extraction",
        max_tokens: 1024,
        temperature: 0,
        // PINNED to Gemini deliberately. Left unpinned the gateway rotates
        // providers, and roughly half of all cheques landed on the free
        // OpenRouter model — 2-3x slower, occasionally hanging for 100s+, and
        // measurably less accurate (it read the cheque number off the printed
        // box instead of the MICR band). Correctness matters more than failover
        // here, and we still fall back to local OCR below if Gemini fails.
        provider: "gemini",
      }),
      // A stalled fallback provider must not hold the whole queue: Gemini answers
      // in ~1.5s, so 25s is generous. On timeout we drop to local OCR instead.
      signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { parsed?: Record<string, unknown> | null; provider?: string };
    if (!data.parsed) return null;
    return { fields: normalizeExtracted(data.parsed), provider: data.provider };
  } catch {
    return null;
  }
}

/** Local Tesseract OCR fallback (printed fields only). Null on failure. */
async function extractViaOCR(dataUrl: string): Promise<ChequeFields | null> {
  try {
    const resp = await fetch(`${OCR_URL}/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { fields?: Record<string, unknown> };
    if (!data.fields || Object.keys(data.fields).length === 0) return null;
    return normalizeExtracted(data.fields);
  } catch {
    return null;
  }
}

/**
 * Extract cheque fields from one page image (base64 data-URL). Tries AI vision
 * (Gemini) first; if the gateway is down / quota-exhausted, falls back to the
 * local Tesseract OCR sidecar (printed fields only). If BOTH are unavailable the
 * client just gets { ok:false } and the manager types — uploads never block.
 * The image is passed through transiently and never stored. Admin/manager only.
 */
export async function extractCheque(dataUrl: string): Promise<ExtractResult> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Not signed in." };
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return { ok: false, error: "Invalid image." };
  }

  const ai = await extractViaAI(dataUrl);
  if (ai) return { ok: true, fields: ai.fields, source: "ai", provider: ai.provider };

  const ocr = await extractViaOCR(dataUrl);
  if (ocr) return { ok: true, fields: ocr, source: "ocr" };

  return { ok: false, error: "AI and OCR both unavailable — enter manually." };
}

/**
 * Detect how far a scanned page is out of true, via Tesseract OSD on the local
 * sidecar. Deterministic and purpose-built — unlike a vision model, which reads
 * an upside-down cheque happily and then reports "0". Returns degrees to rotate
 * CLOCKWISE (0/90/180/270); 0 whenever we can't tell, so upload never blocks.
 */
export async function detectRotation(dataUrl: string): Promise<number> {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return 0;
  try {
    const resp = await fetch(`${OCR_URL}/osd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl }),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) return 0;
    const data = (await resp.json()) as { rotate?: number; confidence?: number };
    const rotate = Number(data.rotate ?? 0);
    // Below ~1 the orientation call is basically a coin flip — leave it alone.
    if (!(Number(data.confidence ?? 0) >= 1)) return 0;
    return rotate === 90 || rotate === 180 || rotate === 270 ? rotate : 0;
  } catch {
    return 0;
  }
}

const EDITABLE: (keyof ChequeFields)[] = [
  "cheque_number", "cheque_date", "received_date", "amount", "amount_in_words", "dealer_name",
  "bank_name", "branch", "ifsc", "account_number", "micr_code", "payee_name", "notes",
];

/** Keep only the whitelisted editable fields, trimmed; drop empties. */
function clean(fields: ChequeFields): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of EDITABLE) {
    const v = fields[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s !== "") out[k] = s;
  }
  return out;
}

function revalidate() {
  revalidatePath("/cheques");
  revalidatePath("/cheques/reconciliation");
}

/**
 * Create N draft cheques in one round-trip (used by both single-add and bulk
 * upload — the bulk uploader renders each PDF page/image client-side and only
 * the FIELDS are sent; images are never uploaded, per extract-and-forget).
 * Optionally submits each right away (submit goes straight to reconciliation).
 */
export async function createCheques(
  rows: ChequeFields[],
  submit: boolean
): Promise<ChequeActionState> {
  if (!Array.isArray(rows) || rows.length === 0) return { error: "Nothing to save." };
  const supabase = await createSupabaseServerClient();
  void supabase;

  // ── Duplicate guard (identity = IFSC/MICR + account + cheque number) ──
  // Block a cheque that already exists in the system in any NON-bounced state
  // (a bounced cheque may be re-presented, so it's allowed), and block the same
  // cheque appearing twice within this upload. Nothing is inserted if a
  // duplicate is found, so the batch is all-or-nothing.
  const cleaned = rows.map(clean);
  const label = (f: Record<string, string>) =>
    `#${f.cheque_number || "?"}${f.account_number ? ` (a/c ${f.account_number})` : ""}`;

  const existingKeys = await existingIdentityKeys();

  const batchKeys = new Set<string>();
  for (const f of cleaned) {
    const keys = chequeIdentityKeys(f);
    for (const k of keys) {
      if (existingKeys.has(k)) {
        return { error: `Cheque ${label(f)} is already in the system (and not bounced). Remove it, then save.` };
      }
      if (batchKeys.has(k)) {
        return { error: `Cheque ${label(f)} appears more than once in this upload. Remove the duplicate, then save.` };
      }
    }
    for (const k of keys) batchKeys.add(k);
  }

  // Every new cheque is filed under the firm you are working in. The payee is
  // what makes a cheque belong to a firm, so an unset payee here would create a
  // cheque that shows up in every firm's books — see belongsToFirm.
  const firm = await requireFirm();

  let count = 0;
  for (const raw of rows) {
    const fields = clean(raw);
    // Derive amount in words when an amount is present but words were left blank.
    if (fields.amount && !fields.amount_in_words) {
      const words = amountToWords(fields.amount);
      if (words) fields.amount_in_words = words;
    }
    // Trust the selected firm over whatever OCR/AI read off the cheque image.
    fields.payee_name = firm.name;
    const { data: id, error } = await supabase.rpc("create_cheque", { p: fields });
    if (error) return { error: error.message, count };
    if (submit && id) {
      const { error: subErr } = await supabase.rpc("submit_cheque", { p_id: id });
      if (subErr) return { error: `Saved but couldn't submit: ${subErr.message}`, count };
    }
    count++;
  }

  revalidate();
  return { ok: true, count };
}

export async function updateChequeDraft(id: string, fields: ChequeFields): Promise<ChequeActionState> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("update_cheque_draft", { p_id: id, p: clean(fields) });
  if (error) return { error: error.message };
  revalidate();
  return { ok: true };
}

/** Admin fixes any editable field on a cheque (reconciliation edit modal). */
export async function adminUpdateCheque(id: string, fields: ChequeFields): Promise<ChequeActionState> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("admin_update_cheque", { p_id: id, p: clean(fields) });
  if (error) return { error: error.message };
  revalidate();
  return { ok: true };
}

/** Apply a batch of ledger-derived outcomes (auto-reconciliation). Admin only. */
export type LedgerSettlement = {
  id: string;
  passed: boolean;
  presentedDate: string | null;
  outcomeDate: string | null;
  reason: string;
};
export async function applyLedgerSettlements(items: LedgerSettlement[]): Promise<ChequeActionState> {
  if (!Array.isArray(items) || items.length === 0) return { error: "Nothing to apply." };
  const supabase = await createSupabaseServerClient();
  let count = 0;
  for (const it of items) {
    const { error } = await supabase.rpc("admin_auto_settle_cheque", {
      p_id: it.id,
      p_passed: it.passed,
      p_presented_date: it.presentedDate || null,
      p_outcome_date: it.outcomeDate || null,
      p_reason: it.reason || "",
    });
    if (error) return { error: `${error.message} (after ${count} applied)`, count };
    count++;
  }
  revalidate();
  return { ok: true, count };
}

export async function submitCheque(id: string): Promise<ChequeActionState> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("submit_cheque", { p_id: id });
  if (error) return { error: error.message };
  revalidate();
  return { ok: true };
}

export async function recordPresented(
  id: string, bankAccountId: string, date: string
): Promise<ChequeActionState> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("record_cheque_presented", {
    p_id: id, p_bank_account: bankAccountId || null, p_date: date || null,
  });
  if (error) return { error: error.message };
  revalidate();
  return { ok: true };
}

/**
 * The settlement date is deliberately not a parameter: a null p_date makes the
 * RPC stamp cleared_date itself, in the warehouse timezone, so it cannot be set
 * from a client clock or a stale rendered page.
 */
export async function markOutcome(
  id: string, passed: boolean, reason: string
): Promise<ChequeActionState> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("mark_cheque_outcome", {
    p_id: id, p_passed: passed, p_date: null, p_reason: reason.trim(),
  });
  if (error) return { error: error.message };
  revalidate();
  return { ok: true };
}

// ── Company bank accounts (admin) ────────────────────────────────────────────
export async function saveBankAccount(
  _prev: ChequeActionState, formData: FormData
): Promise<ChequeActionState> {
  const label = String(formData.get("label") ?? "").trim();
  if (!label) return { error: "A label is required." };
  const supabase = await createSupabaseServerClient();
  // Payee IS the firm, so a new account defaults to the firm you are working
  // in. An explicit payee on the form still wins — that is how you create the
  // first account for a brand-new firm.
  const firm = await getActiveFirm();
  const payee = String(formData.get("payee") ?? "").trim() || firm?.name || null;

  const { error } = await supabase.from("company_bank_accounts").insert({
    label,
    bank_name: String(formData.get("bank_name") ?? "").trim() || null,
    account_number: String(formData.get("account_number") ?? "").trim() || null,
    ifsc: String(formData.get("ifsc") ?? "").trim() || null,
    payee,
  });
  if (error) return { error: error.message };
  revalidatePath("/cheques/bank-accounts");
  revalidatePath("/cheques/reconciliation");
  return { ok: true };
}

export async function toggleBankAccount(id: string, active: boolean): Promise<ChequeActionState> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("company_bank_accounts").update({ is_active: active }).eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/cheques/bank-accounts");
  revalidatePath("/cheques/reconciliation");
  return { ok: true };
}

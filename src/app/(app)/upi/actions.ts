"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { normFirm, isMaskedVpa, isValidPayerAccount } from "@/lib/upi";

export type UpiActionState = { error?: string; ok?: boolean };

function revalidate() {
  revalidatePath("/upi");
  revalidatePath("/upi/reconcile");
}

export async function addMapping(upi_id: string, dealer_name: string, firm: string): Promise<UpiActionState> {
  const id = upi_id.trim();
  const name = dealer_name.trim();
  if (!id) return { error: "UPI ID is required." };
  if (!id.includes("@")) return { error: "That doesn't look like a UPI ID (missing @)." };
  if (isMaskedVpa(id)) return { error: "That UPI ID is masked (has *). Map the payer account instead, from the Reconcile tab." };
  if (!name) return { error: "Dealer name is required." };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("upi_mappings").insert({ upi_id: id, dealer_name: name, firm: normFirm(firm) });
  if (error) {
    return { error: /firm_upi_id_key|duplicate/i.test(error.message) ? "That UPI ID is already mapped for this firm." : error.message };
  }
  revalidate();
  return { ok: true };
}

type BulkPair = { upi_id?: string | null; payer_account?: string | null; dealer_name: string };

/**
 * Bulk-add from a reviewed reconciliation file, for one firm.
 *
 * UPI IDs: deduped, masked ones dropped, any already mapped skipped (a mapping
 * is never overwritten from a file). Payer accounts: the file is the person's
 * explicit answer, so they overwrite — except an account given two different
 * dealers in the same file, which is skipped and counted as a conflict.
 */
export async function bulkAddMappings(
  pairs: BulkPair[],
  firm: string
): Promise<{ added?: number; skipped?: number; accounts?: number; conflicts?: number; error?: string }> {
  const theFirm = normFirm(firm);
  const clean: { upi_id: string; dealer_name: string; firm: string }[] = [];
  const seen = new Set<string>();
  const acctDealers = new Map<string, { dealers: Set<string>; vpa: string | null }>();
  for (const p of pairs ?? []) {
    const u = String(p.upi_id ?? "").trim();
    const d = String(p.dealer_name ?? "").trim();
    if (!d) continue;
    if (u.includes("@") && !isMaskedVpa(u) && !seen.has(u.toLowerCase())) {
      seen.add(u.toLowerCase());
      clean.push({ upi_id: u, dealer_name: d, firm: theFirm });
    }
    const a = String(p.payer_account ?? "").trim();
    if (isValidPayerAccount(a)) {
      const s = acctDealers.get(a) ?? { dealers: new Set<string>(), vpa: u || null };
      s.dealers.add(d);
      acctDealers.set(a, s);
    }
  }

  const supabase = await createSupabaseServerClient();
  let added = 0;
  let skipped = 0;
  if (clean.length) {
    const { data: existing, error: readErr } = await supabase
      .from("upi_mappings").select("upi_id").eq("firm", theFirm);
    if (readErr) return { error: readErr.message };
    const have = new Set((existing ?? []).map((r) => String(r.upi_id).toLowerCase()));
    const toInsert = clean.filter((p) => !have.has(p.upi_id.toLowerCase()));
    if (toInsert.length) {
      const { error } = await supabase.from("upi_mappings").insert(toInsert);
      if (error) return { error: error.message };
    }
    added = toInsert.length;
    skipped = clean.length - toInsert.length;
  }

  const accountRows = [...acctDealers.entries()]
    .filter(([, s]) => s.dealers.size === 1)
    .map(([payer_account, s]) => ({
      firm: theFirm, payer_account, dealer_name: [...s.dealers][0], source: "bulk", sample_vpa: s.vpa,
    }));
  const conflicts = acctDealers.size - accountRows.length;
  if (accountRows.length) {
    const { error } = await supabase
      .from("upi_payer_accounts")
      .upsert(accountRows, { onConflict: "firm,payer_account" });
    if (error) return { error: error.message };
  }

  revalidate();
  return { added, skipped, accounts: accountRows.length, conflicts };
}

/**
 * Confirm who paid one statement line. Saves the payer account (overwriting any
 * earlier answer for it) and, when the UPI ID is visible and not yet mapped for
 * this firm, the UPI ID too.
 */
export async function confirmMatch(input: {
  firm: string;
  dealer_name: string;
  payer_account?: string | null;
  upi_id?: string | null;
}): Promise<UpiActionState & { savedVpa?: boolean; savedAccount?: boolean }> {
  const firm = normFirm(input.firm);
  const dealer = String(input.dealer_name ?? "").trim();
  if (!dealer) return { error: "Pick or type a dealer name." };
  const acct = String(input.payer_account ?? "").trim();
  const vpa = String(input.upi_id ?? "").trim();
  const canAccount = isValidPayerAccount(acct);
  const canVpa = vpa.includes("@") && !isMaskedVpa(vpa);
  if (!canAccount && !canVpa) return { error: "This line has neither a payer account nor a visible UPI ID to save." };

  const supabase = await createSupabaseServerClient();
  if (canAccount) {
    const { error } = await supabase.from("upi_payer_accounts").upsert(
      { firm, payer_account: acct, dealer_name: dealer, source: "manual", sample_vpa: vpa || null },
      { onConflict: "firm,payer_account" }
    );
    if (error) return { error: error.message };
  }

  let savedVpa = false;
  if (canVpa) {
    const { data: existing, error: readErr } = await supabase
      .from("upi_mappings").select("upi_id").eq("firm", firm);
    if (readErr) return { error: readErr.message };
    const have = (existing ?? []).some((r) => String(r.upi_id).toLowerCase() === vpa.toLowerCase());
    if (!have) {
      const { error } = await supabase.from("upi_mappings").insert({ upi_id: vpa, dealer_name: dealer, firm });
      if (error) return { error: error.message };
      savedVpa = true;
    }
  }

  revalidate();
  return { ok: true, savedAccount: canAccount, savedVpa };
}

/**
 * Save the payer accounts a statement taught us (account seen paying from a
 * cleanly-mapped UPI ID). Never overwrites an account already saved — those
 * may be manual corrections.
 */
export async function saveLearnedAccounts(
  firm: string,
  rows: { payer_account: string; dealer_name: string; sample_vpa?: string | null }[]
): Promise<{ added?: number; skipped?: number; error?: string }> {
  const theFirm = normFirm(firm);
  const clean = (rows ?? []).filter((r) => isValidPayerAccount(r.payer_account) && String(r.dealer_name ?? "").trim());
  if (!clean.length) return { added: 0, skipped: 0 };

  const supabase = await createSupabaseServerClient();
  const { data: existing, error: readErr } = await supabase
    .from("upi_payer_accounts").select("payer_account").eq("firm", theFirm);
  if (readErr) return { error: readErr.message };
  const have = new Set((existing ?? []).map((r) => String(r.payer_account)));
  const toInsert = clean
    .filter((r) => !have.has(r.payer_account))
    .map((r) => ({
      firm: theFirm, payer_account: r.payer_account, dealer_name: r.dealer_name.trim(),
      source: "statement", sample_vpa: r.sample_vpa ?? null,
    }));
  if (toInsert.length) {
    const { error } = await supabase.from("upi_payer_accounts").insert(toInsert);
    if (error) return { error: error.message };
  }
  revalidate();
  return { added: toInsert.length, skipped: clean.length - toInsert.length };
}

export async function deleteMapping(id: string): Promise<UpiActionState> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("upi_mappings").delete().eq("id", id);
  if (error) return { error: error.message };
  revalidate();
  return { ok: true };
}

export async function deletePayerAccount(id: string): Promise<UpiActionState> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("upi_payer_accounts").delete().eq("id", id);
  if (error) return { error: error.message };
  revalidate();
  return { ok: true };
}

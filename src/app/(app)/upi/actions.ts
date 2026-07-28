"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { normFirm } from "@/lib/upi";

export type UpiActionState = { error?: string; ok?: boolean };

export async function addMapping(upi_id: string, dealer_name: string, firm: string): Promise<UpiActionState> {
  const id = upi_id.trim();
  const name = dealer_name.trim();
  if (!id) return { error: "UPI ID is required." };
  if (!id.includes("@")) return { error: "That doesn't look like a UPI ID (missing @)." };
  if (!name) return { error: "Dealer name is required." };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("upi_mappings").insert({ upi_id: id, dealer_name: name, firm: normFirm(firm) });
  if (error) {
    return { error: /firm_upi_id_key|duplicate/i.test(error.message) ? "That UPI ID is already mapped for this firm." : error.message };
  }
  revalidatePath("/upi");
  return { ok: true };
}

/**
 * Bulk-add UPI→dealer mappings for one firm from a reviewed reconciliation file.
 * Dedupes by UPI id, skips any already mapped for that firm (case-insensitive),
 * inserts the rest. Returns how many were newly added vs already present.
 */
export async function bulkAddMappings(
  pairs: { upi_id: string; dealer_name: string }[],
  firm: string
): Promise<{ added?: number; skipped?: number; error?: string }> {
  const theFirm = normFirm(firm);
  const clean: { upi_id: string; dealer_name: string; firm: string }[] = [];
  const seen = new Set<string>();
  for (const p of pairs ?? []) {
    const u = String(p.upi_id ?? "").trim();
    const d = String(p.dealer_name ?? "").trim();
    if (!u.includes("@") || !d) continue;
    const key = u.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({ upi_id: u, dealer_name: d, firm: theFirm });
  }
  if (clean.length === 0) return { added: 0, skipped: 0 };

  const supabase = await createSupabaseServerClient();
  const { data: existing, error: readErr } = await supabase
    .from("upi_mappings").select("upi_id").eq("firm", theFirm);
  if (readErr) return { error: readErr.message };
  const have = new Set((existing ?? []).map((r) => String(r.upi_id).toLowerCase()));
  const toInsert = clean.filter((p) => !have.has(p.upi_id.toLowerCase()));
  if (toInsert.length === 0) return { added: 0, skipped: clean.length };

  const { error } = await supabase.from("upi_mappings").insert(toInsert);
  if (error) return { error: error.message };
  revalidatePath("/upi");
  return { added: toInsert.length, skipped: clean.length - toInsert.length };
}

export async function deleteMapping(id: string): Promise<UpiActionState> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("upi_mappings").delete().eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/upi");
  return { ok: true };
}

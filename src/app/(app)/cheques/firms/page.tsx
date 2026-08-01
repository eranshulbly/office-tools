import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { listFirms, belongsToFirm, getActiveFirm } from "@/lib/firm";
import { payeeKey } from "@/lib/cheque";
import { FirmPicker, type FirmTile } from "../FirmPicker";

export const dynamic = "force-dynamic";

/**
 * Firm selection for the cheque suite.
 *
 * A real route rather than a step hidden inside the /s/cheque redirect, so it
 * can be linked to, bookmarked, and — the point — returned to with the browser
 * Back button or the "Change firm" link on every cheque page.
 *
 * Deliberately does NOT call requireFirm(): this is the page requireFirm sends
 * people to, and doing so would loop.
 */
export default async function FirmsPage() {
  await requireRole("admin", "manager");

  const [firms, active, supabase] = await Promise.all([
    listFirms(),
    getActiveFirm(),
    createSupabaseServerClient(),
  ]);

  const [chequesRes, accountsRes] = await Promise.all([
    supabase.from("cheques").select("payee_name, amount, status").in("status", ["submitted", "presented"]),
    supabase.from("company_bank_accounts").select("payee").eq("is_active", true),
  ]);

  const rows = (chequesRes.data ?? []) as { payee_name: string | null; amount: number | null }[];
  const accts = (accountsRes.data ?? []) as { payee: string | null }[];

  const tiles: FirmTile[] = firms.map((firm) => {
    const mine = rows.filter((c) => belongsToFirm(c.payee_name, firm, firms));
    return {
      firm,
      outstandingCount: mine.length,
      outstandingAmount: mine.reduce((s, c) => s + Number(c.amount ?? 0), 0),
      accounts: accts.filter((a) => payeeKey(a.payee) === firm.key).length,
      isActive: active?.key === firm.key,
    };
  });

  return (
    <div>
      <PageHeader
        title="Choose a firm"
        subtitle="Cheques, reconciliation, the ledger and bank accounts are all scoped to the firm you pick here. A firm is the payee on one of your bank accounts."
      />
      <FirmPicker tiles={tiles} />
    </div>
  );
}

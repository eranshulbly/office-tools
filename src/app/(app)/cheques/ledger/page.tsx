import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Cheque } from "@/lib/types";
import type { SystemCheque } from "@/lib/cheque-ledger";
import { PageHeader } from "@/components/ui";
import { LedgerReconciler } from "./LedgerReconciler";
import { requireFirm, listFirms, scopeToFirm } from "@/lib/firm";
import { FirmBar } from "../FirmPicker";

export const dynamic = "force-dynamic";

export default async function ChequeLedgerPage() {
  await requireRole("admin");
  const firm = await requireFirm();
  const firms = await listFirms();
  const supabase = await createSupabaseServerClient();

  // Outstanding cheques are the only ones a ledger can settle.
  const { data } = await supabase
    .from("cheques")
    .select("id, cheque_number, amount, dealer_name, cheque_date, payee_name, status")
    .in("status", ["submitted", "presented"])
    .order("cheque_date", { ascending: true });

  // Only this firm's cheques are candidates — a statement for one firm must not
  // be able to settle another firm's cheque on a number+amount coincidence.
  const cheques = scopeToFirm((data ?? []) as Cheque[], "payee_name", firm, firms)
    .map((c): SystemCheque => ({
      id: c.id,
      cheque_number: c.cheque_number,
      amount: c.amount,
      dealer_name: c.dealer_name,
      cheque_date: c.cheque_date,
      payee_name: c.payee_name,
      status: c.status,
    }));

  return (
    <div>
      <PageHeader
        title="Auto-reconcile from bank ledger"
        subtitle={`Upload ${firm.name}'s HDFC account statement. Cheques you banked are matched by cheque number + amount and marked passed or bounced. Only confident matches are applied — anything ambiguous is left for you.`}
      />
      <FirmBar firm={firm} firms={firms} />
      <LedgerReconciler cheques={cheques} firm={firm.name} />
    </div>
  );
}

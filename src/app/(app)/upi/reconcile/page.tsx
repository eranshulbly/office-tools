import { requireFeature } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { ReconcileUploader, type Mapping, type PayerAccount } from "./ReconcileUploader";

export const dynamic = "force-dynamic";

export default async function ReconcilePage() {
  await requireFeature("upi-reconcile");
  const supabase = await createSupabaseServerClient();
  const [{ data }, { data: acctData }] = await Promise.all([
    supabase.from("upi_mappings").select("upi_id, dealer_name, review, alt_dealer, firm"),
    supabase.from("upi_payer_accounts").select("payer_account, dealer_name, firm"),
  ]);
  const mappings = (data ?? []) as Mapping[];
  const accounts = (acctData ?? []) as PayerAccount[];

  return (
    <div>
      <PageHeader
        title="Reconcile statement"
        subtitle="Upload a bank statement (.xls / .xlsx). Each UPI credit is matched to a dealer by UPI ID, payer account number, or — when the bank masks the UPI ID — a scored guess you can confirm. The file is read in your browser."
      />
      <ReconcileUploader mappings={mappings} accounts={accounts} />
    </div>
  );
}

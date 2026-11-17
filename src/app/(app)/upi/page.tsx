import { requireFeature } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { UpiMapping, UpiPayerAccount } from "@/lib/types";
import { PageHeader } from "@/components/ui";
import { UpiMappings } from "./UpiMappings";

export const dynamic = "force-dynamic";

export default async function UpiMappingsPage() {
  await requireFeature("upi-mappings");
  const supabase = await createSupabaseServerClient();
  const [{ data }, { data: acctData }] = await Promise.all([
    supabase.from("upi_mappings").select("*").order("dealer_name"),
    supabase.from("upi_payer_accounts").select("*").order("dealer_name"),
  ]);
  const mappings = (data ?? []) as UpiMapping[];
  const accounts = (acctData ?? []) as UpiPayerAccount[];

  return (
    <div>
      <PageHeader
        title="Dealer UPI IDs"
        subtitle="Map each dealer's UPI IDs and payer bank accounts to their name. These are used when you reconcile a bank statement."
      />
      <UpiMappings mappings={mappings} accounts={accounts} />
    </div>
  );
}

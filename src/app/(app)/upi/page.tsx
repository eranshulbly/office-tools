import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { UpiMapping } from "@/lib/types";
import { PageHeader } from "@/components/ui";
import { UpiMappings } from "./UpiMappings";

export const dynamic = "force-dynamic";

export default async function UpiMappingsPage() {
  await requireRole("admin");
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from("upi_mappings").select("*").order("dealer_name");
  const mappings = (data ?? []) as UpiMapping[];

  return (
    <div>
      <PageHeader
        title="Dealer UPI IDs"
        subtitle="Map each dealer's UPI ID to their name. These labels are used when you reconcile a bank statement."
      />
      <UpiMappings mappings={mappings} />
    </div>
  );
}

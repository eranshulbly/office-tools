import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { ReconcileUploader, type Mapping } from "./ReconcileUploader";

export const dynamic = "force-dynamic";

export default async function ReconcilePage() {
  await requireRole("admin");
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from("upi_mappings").select("upi_id, dealer_name, review, firm");
  const mappings = (data ?? []) as Mapping[];

  return (
    <div>
      <PageHeader
        title="Reconcile statement"
        subtitle="Upload a bank statement (.xls / .xlsx). Every UPI transaction is labelled with the dealer from your UPI-ID mappings. The file is read in your browser — nothing is uploaded."
      />
      <ReconcileUploader mappings={mappings} />
    </div>
  );
}

import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Cheque } from "@/lib/types";
import { PageHeader, Card, Section } from "@/components/ui";
import { ChequeEntry } from "./ChequeEntry";
import { ChequeDraftCard } from "./ChequeDraftCard";
import { requireFirm, listFirms, scopeToFirm } from "@/lib/firm";
import { FirmBar } from "./FirmPicker";

export const dynamic = "force-dynamic";

export default async function ChequesPage() {
  const profile = await requireRole("admin", "manager");
  const firm = await requireFirm();
  const firms = await listFirms();
  const supabase = await createSupabaseServerClient();

  const chequesRes = await supabase
    .from("cheques")
    .select("*")
    .order("created_at", { ascending: false });

  // Scoped to the selected firm. Cheques whose payee matches no firm at all are
  // deliberately kept visible here rather than filtered away — see belongsToFirm.
  const cheques = scopeToFirm(
    (chequesRes.data ?? []) as Cheque[],
    "payee_name",
    firm,
    firms
  );

  // The current user's own drafts/rejected cheques are editable inline.
  const myEditable = cheques.filter(
    (c) => c.uploaded_by === profile.id && (c.status === "draft" || c.status === "rejected")
  );

  return (
    <div>
      <PageHeader
        title="Cheques"
        subtitle={`Upload scanned cheques (PDF or images) or enter them by hand, then submit. New cheques are filed under ${firm.name}. Images stay in your browser — only the fields are saved.`}
      />

      <FirmBar firm={firm} firms={firms} />

      {chequesRes.error && (
        <div className="mb-6 rounded border border-red-200 bg-red-50 text-[var(--color-danger)] px-3 py-2 text-sm">
          {chequesRes.error.message}
        </div>
      )}

      <Section title="Add cheques">
        <Card className="p-4">
          <ChequeEntry />
        </Card>
      </Section>

      {myEditable.length > 0 && (
        <Section title={`Your drafts (${myEditable.length})`}>
          <div className="space-y-3">
            {myEditable.map((c) => (
              <ChequeDraftCard key={c.id} cheque={c} />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

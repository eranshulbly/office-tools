import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Cheque } from "@/lib/types";
import { CHEQUE_STATUS_META } from "@/lib/cheque";
import {
  PageHeader, Card, Section, Badge, Table, Th, Td, Empty, money,
} from "@/components/ui";
import { ChequeEntry } from "./ChequeEntry";
import { ChequeDraftCard } from "./ChequeDraftCard";

export const dynamic = "force-dynamic";

function d(v: string | null): string {
  return v ? new Date(v).toLocaleDateString("en-IN") : "—";
}

export default async function ChequesPage() {
  const profile = await requireRole("admin", "manager");
  const supabase = await createSupabaseServerClient();

  const [chequesRes, profilesRes] = await Promise.all([
    supabase.from("cheques").select("*").order("created_at", { ascending: false }),
    supabase.from("profiles").select("id, full_name"),
  ]);

  const cheques = (chequesRes.data ?? []) as Cheque[];
  const nameById = new Map<string, string>(
    (profilesRes.data ?? []).map((p) => [p.id as string, p.full_name as string])
  );

  // The current user's own drafts/rejected cheques are editable inline.
  const myEditable = cheques.filter(
    (c) => c.uploaded_by === profile.id && (c.status === "draft" || c.status === "rejected")
  );

  return (
    <div>
      <PageHeader
        title="Cheques"
        subtitle="Upload scanned cheques (PDF or images) or enter them by hand, then submit. Images stay in your browser — only the fields are saved."
      />

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

      <Section title="All cheques">
        {cheques.length === 0 ? (
          <Empty>No cheques yet.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <Th>Status</Th>
                <Th>Cheque no.</Th>
                <Th>Dealer</Th>
                <Th className="text-right">Amount</Th>
                <Th>Cheque date</Th>
                <Th>Uploaded by</Th>
                <Th>Uploaded</Th>
                <Th>Detail</Th>
              </tr>
            }
          >
            {cheques.map((c) => {
              const meta = CHEQUE_STATUS_META[c.status];
              const detail =
                c.status === "rejected" ? c.decision_reason
                : c.status === "bounced" ? c.bounce_reason
                : c.status === "presented" ? `Presented ${d(c.presented_date)}`
                : c.status === "passed" ? `Cleared ${d(c.cleared_date)}`
                : null;
              return (
                <tr key={c.id}>
                  <Td><Badge tone={meta.tone}>{meta.label}</Badge></Td>
                  <Td>{c.cheque_number ?? "—"}</Td>
                  <Td>{c.dealer_name ?? "—"}</Td>
                  <Td className="text-right tabular">{c.amount != null ? money(c.amount) : "—"}</Td>
                  <Td>{d(c.cheque_date)}</Td>
                  <Td>{c.uploaded_by ? nameById.get(c.uploaded_by) ?? "—" : "—"}</Td>
                  <Td>{d(c.upload_date)}</Td>
                  <Td className="text-muted text-xs">{detail ?? "—"}</Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Section>
    </div>
  );
}

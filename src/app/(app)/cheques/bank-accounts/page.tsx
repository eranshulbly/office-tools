import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { CompanyBankAccount } from "@/lib/types";
import {
  PageHeader, Card, Section, Badge, Table, Th, Td, Empty,
} from "@/components/ui";
import { BankAccountForm } from "./BankAccountForm";
import { BankAccountToggle } from "./BankAccountToggle";

export const dynamic = "force-dynamic";

export default async function BankAccountsPage() {
  await requireRole("admin");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("company_bank_accounts")
    .select("*")
    .order("is_active", { ascending: false })
    .order("label");
  const accounts = (data ?? []) as CompanyBankAccount[];

  return (
    <div>
      <PageHeader
        title="Our bank accounts"
        subtitle="The accounts you present dealer cheques to. These appear when recording a cheque as presented."
      />

      {error && (
        <div className="mb-6 rounded border border-red-200 bg-red-50 text-[var(--color-danger)] px-3 py-2 text-sm">
          {error.message}
        </div>
      )}

      <Section title="Add account">
        <Card className="p-4 max-w-2xl">
          <BankAccountForm />
        </Card>
      </Section>

      <Section title="Accounts">
        {accounts.length === 0 ? (
          <Empty>No bank accounts yet.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <Th>Label</Th>
                <Th>Payee company</Th>
                <Th>Bank</Th>
                <Th>Account no.</Th>
                <Th>IFSC</Th>
                <Th>Status</Th>
                <Th></Th>
              </tr>
            }
          >
            {accounts.map((a) => (
              <tr key={a.id}>
                <Td className="font-medium text-ink">{a.label}</Td>
                <Td>{a.payee ?? "—"}</Td>
                <Td>{a.bank_name ?? "—"}</Td>
                <Td>{a.account_number ?? "—"}</Td>
                <Td>{a.ifsc ?? "—"}</Td>
                <Td>
                  <Badge tone={a.is_active ? "ok" : "neutral"}>{a.is_active ? "Active" : "Inactive"}</Badge>
                </Td>
                <Td className="text-right"><BankAccountToggle id={a.id} active={a.is_active} /></Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}

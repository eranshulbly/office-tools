import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Cheque, ChequeStatus, ChequeFields, CompanyBankAccount } from "@/lib/types";
import { payeeKey } from "@/lib/cheque";
import type { PresentAccount } from "../PresentForm";
import { PageHeader, Card, Section, money } from "@/components/ui";
import { ReconLists, type PresentItem, type OutcomeItem, type SettledItem } from "./ReconLists";

export const dynamic = "force-dynamic";

function StatCard({ label, count, amount, tone }: { label: string; count: number; amount: number; tone: string }) {
  return (
    <Card className="p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: tone }}>{label}</div>
      <div className="mt-1 text-lg font-semibold text-ink tabular">{money(amount)}</div>
      <div className="text-xs text-muted">{count} cheque{count === 1 ? "" : "s"}</div>
    </Card>
  );
}

export default async function ChequeReconciliationPage() {
  await requireRole("admin");
  const supabase = await createSupabaseServerClient();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
  const today = fmt.format(new Date());
  // Cheques are typically presented the next working day, so default to tomorrow.
  const presentDate = fmt.format(new Date(Date.now() + 24 * 60 * 60 * 1000));

  const [summaryRes, queueRes, accountsRes, settledRes] = await Promise.all([
    supabase.from("cheques").select("status, amount"),
    supabase.from("cheques").select("*").in("status", ["submitted", "presented"]).order("cheque_date", { ascending: true }),
    supabase.from("company_bank_accounts").select("*").eq("is_active", true).order("label"),
    supabase.from("cheques").select("*").in("status", ["passed", "bounced"]).order("cleared_date", { ascending: false }).limit(200),
  ]);

  // ── dashboard totals by status ──
  const totals = new Map<ChequeStatus, { count: number; amount: number }>();
  for (const r of summaryRes.data ?? []) {
    const s = r.status as ChequeStatus;
    const t = totals.get(s) ?? { count: 0, amount: 0 };
    t.count += 1;
    t.amount += Number(r.amount ?? 0);
    totals.set(s, t);
  }
  const stat = (s: ChequeStatus) => totals.get(s) ?? { count: 0, amount: 0 };
  const outstanding = {
    count: stat("submitted").count + stat("presented").count,
    amount: stat("submitted").amount + stat("presented").amount,
  };

  const queue = (queueRes.data ?? []) as Cheque[];
  const toPresent = queue.filter((c) => c.status === "submitted");
  const awaitingOutcome = queue.filter((c) => c.status === "presented");
  const accountRows = (accountsRes.data ?? []) as CompanyBankAccount[];
  const accounts: PresentAccount[] = accountRows.map((a) => ({
    id: a.id, label: a.label, bank_name: a.bank_name, account_number: a.account_number, ifsc: a.ifsc,
  }));
  // Auto-fill: the account whose payee matches a cheque's payee (first active match).
  const accountForPayee = (payee: string | null): string | undefined => {
    const k = payeeKey(payee);
    if (!k) return undefined;
    return accountRows.find((a) => a.is_active && payeeKey(a.payee) === k)?.id;
  };

  const toFields = (c: Cheque): ChequeFields => ({
    cheque_number: c.cheque_number ?? "",
    amount: c.amount != null ? String(c.amount) : "",
    cheque_date: c.cheque_date ?? "",
    received_date: c.received_date ?? "",
    dealer_name: c.dealer_name ?? "",
    bank_name: c.bank_name ?? "",
    branch: c.branch ?? "",
    ifsc: c.ifsc ?? "",
    account_number: c.account_number ?? "",
    micr_code: c.micr_code ?? "",
    payee_name: c.payee_name ?? "",
    amount_in_words: c.amount_in_words ?? "",
    notes: c.notes ?? "",
  });

  const presentItems: PresentItem[] = toPresent.map((c) => ({
    id: c.id, amount: c.amount, dealer_name: c.dealer_name, cheque_number: c.cheque_number,
    cheque_date: c.cheque_date, payee_name: c.payee_name, defaultAccountId: accountForPayee(c.payee_name),
    fields: toFields(c),
  }));
  const awaitingItems: OutcomeItem[] = awaitingOutcome.map((c) => ({
    id: c.id, amount: c.amount, dealer_name: c.dealer_name, cheque_number: c.cheque_number,
    cheque_date: c.cheque_date, presented_date: c.presented_date, notes: c.notes,
  }));
  const settledItems: SettledItem[] = ((settledRes.data ?? []) as Cheque[]).map((c) => ({
    id: c.id, status: c.status, cheque_number: c.cheque_number, dealer_name: c.dealer_name,
    payee_name: c.payee_name, amount: c.amount, cheque_date: c.cheque_date,
    cleared_date: c.cleared_date, bounce_reason: c.bounce_reason,
  }));

  return (
    <div>
      <PageHeader
        title="Reconciliation"
        subtitle="Present submitted cheques to the bank, then mark them passed or bounced. Outstanding = presented or awaiting presentation."
        actions={
          <a
            href="/cheques/export"
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium text-ink hover:bg-[var(--color-surface-2)]"
          >
            Export CSV
          </a>
        }
      />

      <Section title="Status">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label="Outstanding" count={outstanding.count} amount={outstanding.amount} tone="var(--color-info)" />
          <StatCard label="Awaiting presentation" count={stat("submitted").count} amount={stat("submitted").amount} tone="var(--color-warn)" />
          <StatCard label="Presented" count={stat("presented").count} amount={stat("presented").amount} tone="var(--color-info)" />
          <StatCard label="Passed" count={stat("passed").count} amount={stat("passed").amount} tone="var(--color-ok)" />
          <StatCard label="Bounced" count={stat("bounced").count} amount={stat("bounced").amount} tone="var(--color-danger)" />
        </div>
      </Section>

      {accounts.length === 0 && (
        <div className="mb-6 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-[var(--color-warn)]">
          Add at least one of your own bank accounts before presenting cheques.{" "}
          <a href="/cheques/bank-accounts" className="underline">Manage bank accounts</a>
        </div>
      )}

      <ReconLists
        present={presentItems}
        accounts={accounts}
        awaiting={awaitingItems}
        settled={settledItems}
        today={today}
        presentDate={presentDate}
      />
    </div>
  );
}

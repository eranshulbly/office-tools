"use client";

import { useMemo, useState, useTransition } from "react";
import { FormError } from "@/components/ui";
import { recordPresented } from "./actions";

const BTN =
  "inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm font-medium border-transparent bg-[var(--color-brand)] text-white hover:bg-[var(--color-brand-strong)] disabled:opacity-50";
const BTN_EDIT =
  "inline-flex items-center gap-1.5 rounded border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-[var(--color-surface-2)]";
const INPUT = "rounded border border-line px-2.5 py-1.5 text-sm";

export type PresentAccount = {
  id: string;
  label: string;
  bank_name: string | null;
  account_number: string | null;
  ifsc: string | null;
};

/**
 * Record that an approved cheque was presented to one of our bank accounts.
 * The account is auto-selected from the cheque's payee (defaultAccountId) and the
 * chosen account's details are shown so the admin can confirm the deposit target.
 */
export function PresentForm({
  id,
  accounts,
  defaultAccountId,
  defaultDate,
  onEdit,
}: {
  id: string;
  accounts: PresentAccount[];
  defaultAccountId?: string;
  defaultDate: string;
  onEdit?: () => void;
}) {
  const [account, setAccount] = useState(defaultAccountId || accounts[0]?.id || "");
  const [date, setDate] = useState(defaultDate);
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  const selected = useMemo(() => accounts.find((a) => a.id === account) ?? null, [accounts, account]);
  const details = selected
    ? [selected.bank_name, selected.account_number, selected.ifsc].filter(Boolean).join(" · ")
    : "";

  function present() {
    setError(undefined);
    startTransition(async () => {
      const res = await recordPresented(id, account, date);
      if (res.error) setError(res.error);
    });
  }

  return (
    <div className="flex flex-col items-start gap-1.5 lg:items-end">
      {/* One row on tablet/desktop; wraps only on a phone so nothing overflows. */}
      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap lg:justify-end">
        <select value={account} onChange={(e) => setAccount(e.target.value)} className={INPUT}>
          {accounts.length === 0 && <option value="">No bank accounts — add one first</option>}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.label}</option>
          ))}
        </select>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={INPUT} />
        <button type="button" className={`${BTN} whitespace-nowrap`} onClick={present} disabled={pending || accounts.length === 0}>
          {pending ? "Saving…" : "Mark presented"}
        </button>
        {onEdit && (
          <button type="button" className={BTN_EDIT} onClick={onEdit}>Edit</button>
        )}
      </div>
      {details && <div className="text-xs text-muted">{details}</div>}
      <FormError message={error} />
    </div>
  );
}

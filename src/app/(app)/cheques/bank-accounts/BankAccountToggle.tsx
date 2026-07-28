"use client";

import { useTransition } from "react";
import { toggleBankAccount } from "../actions";

/** Activate / deactivate a bank account (deactivated ones drop out of the picker). */
export function BankAccountToggle({ id, active }: { id: string; active: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="text-xs font-medium text-brand hover:underline disabled:opacity-50"
      disabled={pending}
      onClick={() => startTransition(async () => { await toggleBankAccount(id, !active); })}
    >
      {pending ? "…" : active ? "Deactivate" : "Reactivate"}
    </button>
  );
}

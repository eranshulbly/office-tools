"use client";

import { useState, useTransition } from "react";
import { FormError } from "@/components/ui";
import { disburseAdvance } from "./actions";

const BTN =
  "inline-flex items-center gap-1.5 rounded border border-transparent bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-brand-strong)] disabled:opacity-50";

/** Mark an approved advance as disbursed (cash handed over) from the Disburse tab. */
export function DisburseAdvanceButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className={BTN}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await disburseAdvance(id);
            if (r.error) setError(r.error);
          })
        }
      >
        {pending ? "Saving…" : "Mark disbursed"}
      </button>
      <FormError message={error} />
    </div>
  );
}

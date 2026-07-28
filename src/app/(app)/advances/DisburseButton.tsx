"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui";
import { recordAdvanceDisbursal, type AdvanceFormState } from "./actions";

const initial: AdvanceFormState = {};

/** Record cash handover for an approved, not-yet-disbursed advance (§3.7.4). */
export function DisburseButton({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState(recordAdvanceDisbursal, initial);

  return (
    <form action={formAction}>
      <input type="hidden" name="p_id" value={id} />
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Recording…" : "Record cash handover"}
      </Button>
      {state.error && (
        <p className="text-[var(--color-danger)] text-xs mt-1">{state.error}</p>
      )}
    </form>
  );
}

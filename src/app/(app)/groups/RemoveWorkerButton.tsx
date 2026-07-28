"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui";
import { setWorkerGroup, type GroupFormState } from "./actions";

const initial: GroupFormState = {};

/** Detach a worker from its group (group_id → null). */
export function RemoveWorkerButton({ workerId }: { workerId: string }) {
  const [state, formAction, pending] = useActionState(setWorkerGroup, initial);

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="worker_id" value={workerId} />
      {/* empty group_id → ungrouped */}
      <input type="hidden" name="group_id" value="" />
      <Button type="submit" variant="ghost" disabled={pending}>
        {pending ? "Removing…" : "Remove"}
      </Button>
      {state.error && (
        <p className="text-[var(--color-danger)] text-xs mt-1">{state.error}</p>
      )}
    </form>
  );
}

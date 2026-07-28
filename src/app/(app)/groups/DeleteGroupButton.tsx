"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui";
import { deleteGroup, type GroupFormState } from "./actions";

const initial: GroupFormState = {};

/** Delete an empty group. The server double-checks it has no workers. */
export function DeleteGroupButton({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState(deleteGroup, initial);

  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="danger" disabled={pending}>
        {pending ? "Deleting…" : "Delete group"}
      </Button>
      {state.error && (
        <p className="text-[var(--color-danger)] text-xs mt-1">{state.error}</p>
      )}
    </form>
  );
}

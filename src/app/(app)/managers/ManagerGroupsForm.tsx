"use client";

import { useActionState } from "react";
import { Button, FormError, FormOk } from "@/components/ui";
import type { WorkerGroup } from "@/lib/types";
import { setManagerGroups, type ManagerFormState } from "./actions";

const initial: ManagerFormState = {};

/**
 * Per-manager checkboxes of every worker group. Submitting replaces the
 * manager's disbursal access with exactly the checked groups.
 */
export function ManagerGroupsForm({
  managerId,
  groups,
  selected,
}: {
  managerId: string;
  groups: WorkerGroup[];
  selected: string[];
}) {
  const [state, formAction, pending] = useActionState(setManagerGroups, initial);
  const selectedSet = new Set(selected);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="manager_id" value={managerId} />

      {groups.length === 0 ? (
        <p className="text-muted text-sm">No groups defined yet.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {groups.map((g) => (
            <label key={g.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="group_ids"
                value={g.id}
                defaultChecked={selectedSet.has(g.id)}
                className="rounded border-line"
              />
              <span>{g.name}</span>
            </label>
          ))}
        </div>
      )}

      <FormError message={state.error} />
      {state.ok && <FormOk message="Access updated." />}

      <Button type="submit" variant="primary" disabled={pending || groups.length === 0}>
        {pending ? "Saving…" : "Save access"}
      </Button>
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { Button, FormError, FormOk } from "@/components/ui";
import {
  computeRun,
  approveRun,
  reopenRun,
  type ActionState,
} from "./actions";

type Variant = "primary" | "default" | "danger" | "ghost";
type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/** One button bound to a run RPC action, surfacing the RPC message verbatim. */
function ActionForm({
  action,
  runId,
  label,
  pendingLabel,
  variant = "default",
  disabled = false,
}: {
  action: Action;
  runId: string;
  label: string;
  pendingLabel: string;
  variant?: Variant;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="run_id" value={runId} />
      <Button type="submit" variant={variant} disabled={pending || disabled}>
        {pending ? pendingLabel : label}
      </Button>
      <FormError message={state.error} />
      <FormOk message={state.ok} />
    </form>
  );
}

/**
 * Draft lifecycle controls. Compute is deterred (disabled) while the period has
 * exceptions — the RPC would raise anyway, this saves a round-trip and is
 * clearer. Approve is only offered once figures are computed and clean.
 */
export function DraftControls({
  runId,
  blocked,
  computed,
  hasLines,
}: {
  runId: string;
  blocked: boolean;
  computed: boolean;
  hasLines: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start gap-4">
      <ActionForm
        action={computeRun}
        runId={runId}
        label="Compute"
        pendingLabel="Computing…"
        variant="primary"
        disabled={blocked}
      />
      <ActionForm
        action={approveRun}
        runId={runId}
        label="Approve"
        pendingLabel="Approving…"
        variant="default"
        disabled={blocked || !computed || !hasLines}
      />
    </div>
  );
}

/** Loud, audited reopen. Requires a reason; blocked by RPC if any line is paid. */
export function ReopenForm({ runId }: { runId: string }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(reopenRun, {});
  return (
    <form
      action={formAction}
      className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3"
    >
      <p className="text-sm font-semibold text-[var(--color-danger)]">
        Reopen run — logged loudly
      </p>
      <p className="text-xs text-muted">
        Reverts the run to draft and releases the advance recoveries it marked. Blocked if any
        line is already paid. A reason is mandatory and recorded in the audit log.
      </p>
      <input type="hidden" name="run_id" value={runId} />
      <textarea
        name="reason"
        required
        rows={2}
        placeholder="Reason (mandatory)"
        className="mt-1 w-full rounded border border-line px-3 py-2 text-sm"
      />
      <Button type="submit" variant="danger" disabled={pending}>
        {pending ? "Reopening…" : "Reopen run"}
      </Button>
      <FormError message={state.error} />
      <FormOk message={state.ok} />
    </form>
  );
}

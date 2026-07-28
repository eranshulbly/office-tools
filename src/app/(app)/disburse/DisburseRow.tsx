"use client";

import { useActionState } from "react";
import { Button, FormError, Td, money } from "@/components/ui";
import { WorkerCell } from "@/components/WorkerAvatar";
import { recordDisbursal, type ActionState } from "./actions";

/** One unpaid payroll line: pick cash/online, optional reference, mark paid. */
export function DisburseRow({
  lineId,
  workerId,
  workerName,
  workerCode,
  workerGroup,
  photoUrl,
  net,
}: {
  lineId: string;
  workerId?: string | null;
  workerName: string;
  workerCode?: string;
  workerGroup?: string | null;
  photoUrl?: string | null;
  net: string;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(recordDisbursal, {});

  return (
    <tr className="align-top">
      <Td>
        <WorkerCell name={workerName} code={workerCode} url={photoUrl} size="sm" />
        {workerGroup && <div className="text-muted mt-0.5 text-xs">{workerGroup}</div>}
      </Td>
      <Td className="tabular text-right font-semibold">{money(net)}</Td>
      <Td>
        <form action={formAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="line_id" value={lineId} />
          {workerId && <input type="hidden" name="worker_id" value={workerId} />}
          <select
            name="pay_mode"
            defaultValue="cash"
            className="rounded border border-line px-2 py-1.5 text-sm"
          >
            <option value="cash">Cash</option>
            <option value="online">Online</option>
          </select>
          <input
            name="payment_reference"
            type="text"
            placeholder="Reference (optional)"
            className="rounded border border-line px-2 py-1.5 text-sm"
          />
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Saving…" : "Mark paid"}
          </Button>
        </form>
        <div className="mt-1">
          <FormError message={state.error} />
        </div>
      </Td>
    </tr>
  );
}

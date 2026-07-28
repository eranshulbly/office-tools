"use client";

import { useActionState } from "react";
import { Button, FormError } from "@/components/ui";
import { createRun, type ActionState } from "./actions";

const inputClass = "mt-1 w-full rounded border border-line px-3 py-2 text-sm";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

/**
 * "New run" form. Defaults are a suggestion (period = the previous full calendar
 * month, pay date = 2nd Saturday of this month) but every field is admin-editable.
 */
export function NewRunForm({
  defaultPeriodStart,
  defaultPeriodEnd,
  defaultPayDate,
}: {
  defaultPeriodStart: string;
  defaultPeriodEnd: string;
  defaultPayDate: string;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createRun, {});

  return (
    <form action={formAction} className="space-y-4">
      <FormError message={state.error} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Field label="Period start">
          <input
            name="period_start"
            type="date"
            required
            defaultValue={defaultPeriodStart}
            className={inputClass}
          />
        </Field>
        <Field label="Period end">
          <input
            name="period_end"
            type="date"
            required
            defaultValue={defaultPeriodEnd}
            className={inputClass}
          />
        </Field>
        <Field label="Pay date">
          <input
            name="pay_date"
            type="date"
            required
            defaultValue={defaultPayDate}
            className={inputClass}
          />
        </Field>
      </div>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Creating…" : "Create draft run"}
      </Button>
    </form>
  );
}

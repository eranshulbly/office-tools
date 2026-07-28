"use client";

import { useActionState, useEffect, useRef } from "react";
import { Button, FormError, FormOk } from "@/components/ui";
import { createManager, type ManagerFormState } from "./actions";

const inputClass = "mt-1 w-full rounded border border-line px-3 py-2 text-sm";
const initial: ManagerFormState = {};

export function CreateManagerForm() {
  const [state, formAction, pending] = useActionState(createManager, initial);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state.ok]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <FormError message={state.error} />
      {state.ok && <FormOk message="Manager account created." />}

      <label className="block text-sm">
        <span className="text-muted">Full name</span>
        <input name="full_name" type="text" required className={inputClass} />
      </label>

      <label className="block text-sm">
        <span className="text-muted">Email</span>
        <input name="email" type="email" required className={inputClass} />
      </label>

      <label className="block text-sm">
        <span className="text-muted">Password</span>
        <input
          name="password"
          type="password"
          required
          minLength={8}
          className={inputClass}
        />
        <span className="text-muted text-xs">At least 8 characters.</span>
      </label>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Creating…" : "Create manager"}
      </Button>
    </form>
  );
}

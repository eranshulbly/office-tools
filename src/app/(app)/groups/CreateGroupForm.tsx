"use client";

import { useActionState, useEffect, useRef } from "react";
import { Button, FormError, FormOk } from "@/components/ui";
import { createGroup, type GroupFormState } from "./actions";

const inputClass = "mt-1 w-full rounded border border-line px-3 py-2 text-sm";
const initial: GroupFormState = {};

export function CreateGroupForm() {
  const [state, formAction, pending] = useActionState(createGroup, initial);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state.ok]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <FormError message={state.error} />
      {state.ok && <FormOk message="Group created." />}

      <label className="block text-sm">
        <span className="text-muted">Group name</span>
        <input name="name" type="text" required className={inputClass} />
      </label>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Creating…" : "Create group"}
      </Button>
    </form>
  );
}

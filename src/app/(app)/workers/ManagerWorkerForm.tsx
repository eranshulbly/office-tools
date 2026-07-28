"use client";

import { startTransition, useActionState, useEffect, useRef, type ReactNode } from "react";
import { Button, FormError, FormOk } from "@/components/ui";
import { requestNewWorker, type ManagerFormState } from "./actions";
import { resizeImage, type WorkerGroupOption } from "./WorkerForm";

const inputClass = "mt-1 w-full rounded border border-line px-3 py-2 text-sm";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

/**
 * Manager-only "add worker" form. Collects the non-confidential fields only —
 * never salary or bank. On submit the photo is downscaled in the browser (same
 * transform as the admin form) and the whole thing is sent to requestNewWorker,
 * which creates a PENDING worker awaiting admin approval.
 */
export function ManagerWorkerForm({ groups }: { groups: WorkerGroupOption[] }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState<ManagerFormState, FormData>(
    requestNewWorker,
    {}
  );
  const todayStr = new Date().toLocaleDateString("en-CA");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const photo = fd.get("photo");
    if (photo instanceof File && photo.size > 0) {
      fd.set("photo", await resizeImage(photo)); // shrink before it ever leaves the browser
    }
    startTransition(() => formAction(fd));
  }

  // Clear the fields once the server confirms the submission.
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state.ok]);

  return (
    <form ref={formRef} onSubmit={onSubmit} className="space-y-4">
      <FormError message={state.error} />
      {state.ok && <FormOk message="Submitted for admin approval." />}

      <p className="text-xs text-muted">An employee code is assigned automatically.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Full name">
          <input
            name="full_name"
            type="text"
            required
            pattern="[A-Za-z][A-Za-z .'-]{1,}"
            title="Letters, spaces, and . ' - only (no digits)."
            className={inputClass}
          />
        </Field>

        <Field label="Phone">
          <input
            name="phone"
            type="tel"
            required
            pattern="(\+?91[- ]?)?[6-9][0-9]{9}"
            title="10-digit Indian mobile number (optionally with +91)."
            className={inputClass}
          />
        </Field>

        <Field label="Group">
          <select name="group_id" required defaultValue="" className={inputClass}>
            <option value="" disabled>
              — select a group —
            </option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Joined on">
          <input name="joined_on" type="date" required max={todayStr} className={inputClass} />
        </Field>
      </div>

      <div className="border-t border-line pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Face photo (optional)">
          <input
            name="photo"
            type="file"
            accept="image/*"
            className="mt-1 text-sm file:mr-2 file:rounded file:border file:border-line file:bg-white file:px-2 file:py-1 file:text-sm"
          />
        </Field>

        <Field label="Identity proof (optional)">
          <input
            name="id_proof"
            type="file"
            accept="image/*,application/pdf"
            className="mt-1 text-sm file:mr-2 file:rounded file:border file:border-line file:bg-white file:px-2 file:py-1 file:text-sm"
          />
        </Field>
      </div>

      <div className="flex items-center gap-2 pt-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Submitting…" : "Submit for approval"}
        </Button>
      </div>
    </form>
  );
}

"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { updateCandidate, type CandidateActionState } from "./actions";
import { FormError, FormOk } from "@/components/ui";
import type { Candidate } from "@/lib/types";

const INPUT =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)]";
const LABEL = "block text-xs font-medium text-muted mb-1";

export function EditCandidateForm({ candidate }: { candidate: Candidate }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<CandidateActionState, FormData>(
    updateCandidate,
    {}
  );

  useEffect(() => {
    if (state.ok) {
      router.refresh();
      // Collapse on success so the page returns to a reading view rather than
      // leaving a form open over the details it just changed.
      setOpen(false);
    }
  }, [state.ok, router]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-[var(--color-surface-2)]"
      >
        Edit details
      </button>
    );
  }

  return (
    <form action={action} className="w-full space-y-3">
      <input type="hidden" name="id" value={candidate.id} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <label className={LABEL} htmlFor="e_full_name">Name *</label>
          <input id="e_full_name" name="full_name" required defaultValue={candidate.full_name} className={INPUT} />
        </div>
        <div>
          <label className={LABEL} htmlFor="e_area">Area</label>
          <input id="e_area" name="area" defaultValue={candidate.area ?? ""} className={INPUT} />
        </div>
        <div>
          <label className={LABEL} htmlFor="e_reference">Reference</label>
          <input id="e_reference" name="reference" defaultValue={candidate.reference ?? ""} className={INPUT} />
        </div>
        <div>
          <label className={LABEL} htmlFor="e_phone">Phone</label>
          <input id="e_phone" name="phone" defaultValue={candidate.phone ?? ""} className={INPUT} />
        </div>
        <div>
          <label className={LABEL} htmlFor="e_position">Position</label>
          <input id="e_position" name="position" defaultValue={candidate.position ?? ""} className={INPUT} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="e_notes">Notes</label>
          <input id="e_notes" name="notes" defaultValue={candidate.notes ?? ""} className={INPUT} />
        </div>
        <div>
          <label className={LABEL} htmlFor="e_resume">Replace resume</label>
          <input
            id="e_resume"
            name="resume"
            type="file"
            accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp"
            className="w-full text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--color-brand-soft)] file:px-3 file:py-2 file:text-sm file:font-medium file:text-[var(--color-brand)]"
          />
          <p className="mt-1 text-xs text-faint">
            {candidate.resume_name
              ? `Currently: ${candidate.resume_name}. Leave empty to keep it.`
              : "No resume on file yet."}
          </p>
        </div>
      </div>

      {state.error && <FormError message={state.error} />}
      {state.ok && <FormOk message="Details updated." />}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center justify-center rounded-lg border border-transparent bg-[var(--color-brand)] px-3.5 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-strong)] disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          className="rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium text-ink hover:bg-[var(--color-surface-2)]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

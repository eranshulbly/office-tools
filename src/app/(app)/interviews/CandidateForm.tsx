"use client";

import { useActionState, useEffect, useRef } from "react";
import { addCandidate, type CandidateActionState } from "./actions";
import { FormError, FormOk } from "@/components/ui";

const INPUT =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)]";
const LABEL = "block text-xs font-medium text-muted mb-1";

export function CandidateForm({ areas = [] }: { areas?: string[] }) {
  const [state, action, pending] = useActionState<CandidateActionState, FormData>(
    addCandidate,
    {}
  );
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the form after a successful add so the next candidate can be typed
  // straight in — this screen is used in runs, not one at a time.
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state.ok]);

  return (
    <form ref={formRef} action={action} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <label className={LABEL} htmlFor="full_name">Name *</label>
          <input id="full_name" name="full_name" required className={INPUT} placeholder="Candidate's full name" />
        </div>
        <div>
          <label className={LABEL} htmlFor="area">Area</label>
          <input id="area" name="area" className={INPUT} placeholder="Area applied for" list="known-areas" />
        </div>
        <div>
          <label className={LABEL} htmlFor="reference">Reference</label>
          <input id="reference" name="reference" className={INPUT} placeholder="Who referred them" />
        </div>
        <div>
          <label className={LABEL} htmlFor="phone">Phone</label>
          <input id="phone" name="phone" className={INPUT} placeholder="Optional" />
        </div>
        <div>
          <label className={LABEL} htmlFor="position">Position</label>
          <input id="position" name="position" className={INPUT} placeholder="Role applied for" />
        </div>
      </div>

      {/* Areas already used, offered as suggestions so the same place isn't
          typed three different ways. Still free text — a new area just works. */}
      <datalist id="known-areas">
        {areas.map((a) => <option key={a} value={a} />)}
      </datalist>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="resume">Resume</label>
          <input
            id="resume"
            name="resume"
            type="file"
            accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp"
            className="w-full text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--color-brand-soft)] file:px-3 file:py-2 file:text-sm file:font-medium file:text-[var(--color-brand)]"
          />
          <p className="mt-1 text-xs text-faint">PDF, Word or image · up to 5 MB</p>
        </div>
        <div>
          <label className={LABEL} htmlFor="notes">Notes</label>
          <input id="notes" name="notes" className={INPUT} placeholder="Anything worth remembering" />
        </div>
      </div>

      {state.error && <FormError message={state.error} />}
      {state.ok && <FormOk message="Candidate added." />}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-transparent bg-[var(--color-brand)] px-3.5 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-strong)] disabled:opacity-50"
      >
        {pending ? "Adding…" : "Add candidate"}
      </button>
    </form>
  );
}

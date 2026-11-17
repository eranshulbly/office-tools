"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { addRound, type CandidateActionState } from "./actions";
import { FormError } from "@/components/ui";

const INPUT =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)]";
const LABEL = "block text-xs font-medium text-muted mb-1";

export function RoundForm({
  candidateId,
  nextRound,
  today,
}: {
  candidateId: string;
  /** max(round_no) + 1, so the common case needs no typing. */
  nextRound: number;
  today: string;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<CandidateActionState, FormData>(addRound, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
      router.refresh();
    }
  }, [state.ok, router]);

  return (
    <form ref={formRef} action={action} className="space-y-3">
      <input type="hidden" name="candidate_id" value={candidateId} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label className={LABEL} htmlFor="round_no">Round *</label>
          <input
            id="round_no" name="round_no" type="number" min={1} max={20}
            defaultValue={nextRound} required className={INPUT}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="round_name">Stage</label>
          <input id="round_name" name="round_name" className={INPUT} placeholder="Telephonic, Technical…" />
        </div>
        <div>
          <label className={LABEL} htmlFor="interviewer">Interviewer</label>
          <input id="interviewer" name="interviewer" className={INPUT} placeholder="Who took it" />
        </div>
        <div>
          <label className={LABEL} htmlFor="interviewed_on">Date</label>
          <input id="interviewed_on" name="interviewed_on" type="date" defaultValue={today} className={INPUT} />
        </div>
      </div>

      <div>
        <label className={LABEL} htmlFor="notes">Notes *</label>
        <textarea
          id="notes" name="notes" required rows={4} className={INPUT}
          placeholder="How did the interview go? Strengths, concerns, anything to follow up on."
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className={LABEL} htmlFor="outcome">Round outcome</label>
          <select id="outcome" name="outcome" defaultValue="pending" className={INPUT}>
            <option value="pending">Pending</option>
            <option value="pass">Passed</option>
            <option value="fail">Did not pass</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-transparent bg-[var(--color-brand)] px-3.5 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-strong)] disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save notes"}
        </button>
        <span className="text-xs text-faint">Notes are saved permanently and can&apos;t be edited later.</span>
      </div>

      {state.error && <FormError message={state.error} />}
    </form>
  );
}

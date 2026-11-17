"use client";

import { startTransition, useActionState, useState, type ReactNode } from "react";
import { Button, FormError, FormOk } from "@/components/ui";
import type { Worker } from "@/lib/types";
import { requestWorkerEdit, type ManagerFormState } from "./actions";
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
 * Manager-only "propose an edit" form. Prefilled with the worker's current
 * non-confidential fields — never salary or bank, and no file uploads. Submitting
 * stores a PENDING change; the live worker row is untouched until an admin
 * approves it.
 */
export function ManagerEditForm({
  worker,
  groups,
}: {
  worker: Worker;
  groups: WorkerGroupOption[];
}) {
  const action = requestWorkerEdit.bind(null, worker.id);
  const [state, formAction, pending] = useActionState<ManagerFormState, FormData>(action, {});
  const [clientError, setClientError] = useState<string>();
  const todayStr = new Date().toLocaleDateString("en-CA");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const g = (k: string) => String(fd.get(k) ?? "").trim();
    const changed =
      g("full_name") !== worker.full_name ||
      g("group_id") !== (worker.group_id ?? "") ||
      g("phone") !== (worker.phone ?? "") ||
      g("joined_on") !== worker.joined_on ||
      g("left_on") !== (worker.left_on ?? "") ||
      (fd.get("is_active") != null) !== worker.is_active;
    const photo = fd.get("photo");
    const idProof = fd.get("id_proof");
    const hasFiles =
      (photo instanceof File && photo.size > 0) || (idProof instanceof File && idProof.size > 0);
    // Block a no-op submission: nothing changed and no new photo / id proof.
    if (!changed && !hasFiles) {
      setClientError("No changes to submit.");
      return;
    }
    setClientError(undefined);
    if (photo instanceof File && photo.size > 0) {
      fd.set("photo", await resizeImage(photo)); // shrink before it leaves the browser
    }
    startTransition(() => formAction(fd));
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <FormError message={clientError ?? state.error} />
      {state.ok && !clientError && <FormOk message="Change submitted for admin approval." />}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Employee code">
          <div className={`${inputClass} bg-[var(--color-surface-2)] text-muted`}>
            {worker.employee_code}
          </div>
        </Field>

        <Field label="Full name">
          <input
            name="full_name"
            type="text"
            pattern="[A-Za-z][A-Za-z .'-]{1,}"
            title="Letters, spaces, and . ' - only (no digits)."
            defaultValue={worker.full_name}
            className={inputClass}
          />
        </Field>

        <Field label="Group">
          <select name="group_id" defaultValue={worker.group_id ?? ""} className={inputClass}>
            {/* Selectable, not disabled: most of the roster has no group, and
                leaving it unset has to stay a valid answer. */}
            <option value="">— no group —</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Phone">
          <input
            name="phone"
            type="tel"
            pattern="(\+?91[- ]?)?[6-9][0-9]{9}"
            title="10-digit Indian mobile number (optionally with +91)."
            defaultValue={worker.phone ?? ""}
            className={inputClass}
          />
        </Field>

        <Field label="Joined on">
          <input
            name="joined_on"
            type="date"
            max={todayStr}
            defaultValue={worker.joined_on}
            className={inputClass}
          />
        </Field>

        <Field label="Left on">
          <input name="left_on" type="date" defaultValue={worker.left_on ?? ""} className={inputClass} />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          name="is_active"
          type="checkbox"
          defaultChecked={worker.is_active}
          onChange={(e) => {
            const leftOn = e.currentTarget.form?.elements.namedItem("left_on") as HTMLInputElement | null;
            if (!leftOn) return;
            if (!e.currentTarget.checked && !leftOn.value) leftOn.value = todayStr;
            else if (e.currentTarget.checked) leftOn.value = "";
          }}
          className="rounded border-line"
        />
        <span>Active</span>
      </label>

      {/* Photo + identity proof apply immediately (not part of the pending change). */}
      <div className="border-t border-line pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Face photo (optional)">
          <input
            name="photo"
            type="file"
            accept="image/*"
            className="mt-1 text-sm file:mr-2 file:rounded file:border file:border-line file:bg-white file:px-2 file:py-1 file:text-sm"
          />
          {worker.photo_path && (
            <span className="text-muted text-xs">A photo is already on file — choosing a new file replaces it.</span>
          )}
        </Field>

        <Field label="Identity proof (optional)">
          <input
            name="id_proof"
            type="file"
            accept="image/*,application/pdf"
            className="mt-1 text-sm file:mr-2 file:rounded file:border file:border-line file:bg-white file:px-2 file:py-1 file:text-sm"
          />
          {worker.id_proof_path && (
            <span className="text-muted text-xs">An identity proof is already on file.</span>
          )}
        </Field>
      </div>

      <div className="flex items-center gap-2 pt-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Submitting…" : "Submit change for approval"}
        </Button>
      </div>
    </form>
  );
}

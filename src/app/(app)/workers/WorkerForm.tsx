"use client";

import { startTransition, useActionState, type ReactNode } from "react";
import { Button, FormError } from "@/components/ui";
import { WorkerAvatar } from "@/components/WorkerAvatar";
import type { Worker } from "@/lib/types";
import { createWorker, updateWorker, type WorkerFormState } from "./actions";

const inputClass = "mt-1 w-full rounded border border-line px-3 py-2 text-sm";

/**
 * Downscale + compress a photo in the browser BEFORE upload so we only ever
 * store/serve a small thumbnail (~20–40 KB). A face at ~256 px is plenty to
 * recognise someone, and this is the biggest lever on Supabase egress. Falls
 * back to the original file if anything about the transform fails.
 */
export async function resizeImage(file: File, maxDim = 256, quality = 0.72): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    // Prefer WebP; fall back to JPEG if the browser can't encode it.
    const encode = (type: string) =>
      new Promise<Blob | null>((res) => canvas.toBlob(res, type, quality));
    let blob = await encode("image/webp");
    let ext = "webp";
    if (!blob || blob.type !== "image/webp") {
      blob = await encode("image/jpeg");
      ext = "jpg";
    }
    if (!blob) return file;

    // If, for a tiny source, the re-encode is somehow larger, keep the original.
    if (blob.size >= file.size) return file;

    const base = file.name.replace(/\.[^.]+$/, "");
    return new File([blob], `${base}.${ext}`, { type: blob.type });
  } catch {
    return file;
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

export type WorkerGroupOption = { id: string; name: string };

export function WorkerForm({
  mode,
  worker,
  photoUrl,
  hasIdProof,
  groups = [],
  bank,
}: {
  mode: "create" | "edit";
  worker?: Worker;
  photoUrl?: string | null;
  hasIdProof?: boolean;
  groups?: WorkerGroupOption[];
  bank?: { bank_account: string | null; bank_ifsc: string | null } | null;
}) {
  const extra = worker;
  const action = mode === "create" ? createWorker : updateWorker;
  const [state, formAction, pending] = useActionState<WorkerFormState, FormData>(action, {});
  const todayStr = new Date().toLocaleDateString("en-CA");

  /**
   * On EDIT, nothing is mandatory — not even the salary.
   *
   * Every field being mandatory made the form unusable for its most common
   * job: opening an existing employee to change one thing. The records were
   * imported without phone, group or salary, so saving anything meant first
   * inventing the rest — data worse than the blank it replaced. Requiring just
   * the salary still blocked the 28 people who do not have one on file.
   *
   * A blank box keeps whatever is stored; it never writes an empty value.
   *
   * Creating a new employee still asks for the full set: that is the one moment
   * the information is actually to hand.
   */
  const creating = mode === "create";

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const photo = fd.get("photo");
    if (photo instanceof File && photo.size > 0) {
      fd.set("photo", await resizeImage(photo)); // shrink before it ever leaves the browser
    }
    startTransition(() => formAction(fd));
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {worker && <input type="hidden" name="id" value={worker.id} />}

      <FormError message={state.error} />

      {mode === "create" && (
        <p className="text-xs text-muted">An employee code is assigned automatically.</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {mode === "edit" && (
          <Field label="Employee code">
            <div className={`${inputClass} bg-[var(--color-surface-2)] text-muted`}>
              {worker?.employee_code ?? "—"}
            </div>
          </Field>
        )}

        <Field label="Full name">
          <input
            name="full_name"
            type="text"
            required={creating}
            pattern="[A-Za-z][A-Za-z .'-]{1,}"
            title="Letters, spaces, and . ' - only (no digits)."
            defaultValue={worker?.full_name_only ?? worker?.full_name ?? ""}
            className={inputClass}
          />
        </Field>

        <Field label="Designation">
          <input
            name="designation"
            type="text"
            maxLength={120}
            placeholder="Driver, Store Keeper, Helper…"
            defaultValue={worker?.designation ?? ""}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-faint">
            Shown on the attendance device as &ldquo;Name - Designation&rdquo;.
          </p>
        </Field>

        <Field label="Monthly salary (₹)">
          {/*
            Whole rupees, typed only.

            Not type="number": that renders the up/down spinner, and it also
            makes the field respond to the MOUSE WHEEL — scrolling the page
            with the cursor over it silently edits the amount. On a salary
            field that is a quiet way to pay somebody the wrong number.

            type="text" with inputMode="numeric" removes both and still brings
            up the numeric keypad on a phone. The pattern blocks a decimal
            point in the browser; the server checks for a whole number too,
            since a pattern is only a hint.
          */}
          <input
            name="monthly_salary"
            type="text"
            inputMode="numeric"
            pattern="[0-9]+"
            title="Whole rupees only — digits, no decimal point or commas."
            autoComplete="off"
            required={creating}
            defaultValue={
              worker && worker.monthly_salary != null
                ? String(Math.round(Number(worker.monthly_salary)))
                : ""
            }
            className={inputClass}
          />
          {!creating && (
            <p className="mt-1 text-xs text-faint">
              Payroll cannot run without this, but it is not required to save — leave it
              blank and the current value is kept, like every other field here.
            </p>
          )}
        </Field>

        <Field label="Bank account">
          <input
            name="bank_account"
            type="text"
            defaultValue={bank?.bank_account ?? ""}
            className={inputClass}
          />
        </Field>

        <Field label="Bank IFSC">
          <input
            name="bank_ifsc"
            type="text"
            defaultValue={bank?.bank_ifsc ?? ""}
            className={inputClass}
          />
        </Field>

        <Field label="Group">
          <select
            name="group_id"
            required={creating}
            defaultValue={extra?.group_id ?? ""}
            className={inputClass}
          >
            <option value="" disabled={creating}>
              — select a group —
            </option>
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
            required={creating}
            pattern="(\+?91[- ]?)?[6-9][0-9]{9}"
            title="10-digit Indian mobile number (optionally with +91)."
            defaultValue={extra?.phone ?? ""}
            className={inputClass}
          />
        </Field>

        <Field label="Joined on">
          <input
            name="joined_on"
            type="date"
            required={creating}
            max={todayStr}
            defaultValue={worker?.joined_on ?? ""}
            className={inputClass}
          />
        </Field>

        {mode === "edit" && (
          <Field label="Left on">
            <input
              name="left_on"
              type="date"
              defaultValue={worker?.left_on ?? ""}
              className={inputClass}
            />
          </Field>
        )}
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          name="is_active"
          type="checkbox"
          defaultChecked={worker ? worker.is_active : true}
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

      {/* Photo + identity proof — both optional, can be added later. */}
      <div className="border-t border-line pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Face photo (optional)">
          <div className="flex items-center gap-3 mt-1">
            {mode === "edit" && (
              <WorkerAvatar name={worker?.full_name ?? ""} url={photoUrl} size="lg" />
            )}
            <input
              name="photo"
              type="file"
              accept="image/*"
              className="text-sm file:mr-2 file:rounded file:border file:border-line file:bg-white file:px-2 file:py-1 file:text-sm"
            />
          </div>
          {mode === "edit" && photoUrl && (
            <span className="text-muted text-xs">A photo is already on file — choosing a new file replaces it.</span>
          )}
        </Field>

        <Field label="Identity proof (optional, admin-only)">
          <input
            name="id_proof"
            type="file"
            accept="image/*,application/pdf"
            className="mt-1 text-sm file:mr-2 file:rounded file:border file:border-line file:bg-white file:px-2 file:py-1 file:text-sm"
          />
          {mode === "edit" && hasIdProof && (
            <span className="text-muted text-xs">An identity proof is already on file.</span>
          )}
        </Field>
      </div>

      <div className="flex items-center gap-2 pt-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : mode === "create" ? "Create employee" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

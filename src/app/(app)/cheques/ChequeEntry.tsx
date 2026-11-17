"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, FormError, FormOk } from "@/components/ui";
import type { ChequeFields } from "@/lib/types";
import { amountToWords, chequeIdentityKeys } from "@/lib/cheque";
import { createCheques, extractCheque, detectRotation, findKnownDuplicates } from "./actions";
import { CHEQUE_FIELD_DEFS as FIELDS, chequeMissingRequired } from "./fields";

const inputClass = "mt-0.5 w-full rounded border border-line px-2.5 py-1.5 text-sm";
const labelClass = "text-xs font-medium text-muted";
const BTN_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_PRIMARY = `${BTN_BASE} bg-[var(--color-brand)] text-white border-transparent shadow-[var(--shadow-sm)] hover:bg-[var(--color-brand-strong)]`;
const BTN_DEFAULT = `${BTN_BASE} bg-surface text-ink border-line hover:bg-[var(--color-surface-2)] hover:border-line-strong`;
const BTN_DANGER = `${BTN_BASE} bg-surface text-[var(--color-danger)] border-line hover:bg-red-50 hover:border-red-200`;

/**
 * Requests are sent one at a time: the vision gateway returns 502/503 under
 * concurrent load, so parallelism makes things worse, not better. Gemini itself
 * paces sustained traffic (~1.3s per call when spaced, ~4s back-to-back), so no
 * artificial gap is needed. The window below is only a runaway guard.
 */
const AI_MAX_PER_MIN = 20;
const AI_CONCURRENCY = 1;

type ExtractStatus = "idle" | "queued" | "extracting" | "ai" | "ocr" | "failed";

type Entry = {
  key: string;
  image: string | null; // client-side dataURL, NEVER uploaded except transiently for extraction
  fields: ChequeFields;
  status: ExtractStatus;
  note?: string;
};

let seq = 0;
const nextKey = () => `e${seq++}`;
// Received-on defaults to the upload date (today) — the cheque was received today.
const todayStr = () => new Date().toLocaleDateString("en-CA");

/**
 * Cheques are landscape, but scanned PDFs/images often come in rotated (portrait).
 * Return a landscape JPEG data-URL — if the canvas is taller than wide, rotate it
 * 90° counter-clockwise so the cheque reads horizontally.
 */
function landscapeDataUrl(canvas: HTMLCanvasElement): string {
  if (canvas.height <= canvas.width) return canvas.toDataURL("image/jpeg", 0.8);
  const r = document.createElement("canvas");
  r.width = canvas.height;
  r.height = canvas.width;
  const ctx = r.getContext("2d");
  if (!ctx) return canvas.toDataURL("image/jpeg", 0.8);
  ctx.translate(0, r.height);
  ctx.rotate(-Math.PI / 2);
  ctx.drawImage(canvas, 0, 0);
  return r.toDataURL("image/jpeg", 0.8);
}

/**
 * Rotate an image data-URL by 90/180/270 degrees CLOCKWISE. Used to straighten
 * cheques that were scanned sideways or upside down — the AI reports how far
 * out the image is, and the manager can nudge it by hand too.
 */
function rotateDataUrl(dataUrl: string, deg: number): Promise<string> {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return Promise.resolve(dataUrl);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const swap = d === 90 || d === 270;
      const c = document.createElement("canvas");
      c.width = swap ? img.naturalHeight : img.naturalWidth;
      c.height = swap ? img.naturalWidth : img.naturalHeight;
      const ctx = c.getContext("2d");
      if (!ctx) return resolve(dataUrl);
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate((d * Math.PI) / 180);
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/** Load an image data-URL into a canvas and return it as a landscape data-URL. */
function toLandscape(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      if (!ctx) return resolve(dataUrl);
      ctx.drawImage(img, 0, 0);
      resolve(landscapeDataUrl(c));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

const STATUS_CHIP: Record<ExtractStatus, { label: string; cls: string } | null> = {
  idle: null,
  queued: { label: "Queued for AI…", cls: "bg-[var(--color-surface-2)] text-muted" },
  extracting: { label: "Extracting…", cls: "bg-[var(--color-info-soft)] text-[var(--color-info)]" },
  ai: { label: "AI-filled — review", cls: "bg-[var(--color-ok-soft)] text-[var(--color-ok)]" },
  ocr: { label: "OCR-filled (printed only) — verify", cls: "bg-[var(--color-warn-soft)] text-[var(--color-warn)]" },
  failed: { label: "AI & OCR unavailable — enter manually", cls: "bg-[var(--color-warn-soft)] text-[var(--color-warn)]" },
};

export function ChequeEntry() {
  const router = useRouter();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [rendering, setRendering] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [okMsg, setOkMsg] = useState<string | undefined>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  // Extraction queue (refs so it survives re-renders without re-triggering).
  const queueRef = useRef<string[]>([]);
  const inFlightRef = useRef(0);
  const callTimesRef = useRef<number[]>([]); // starts within the last 60s
  const imagesRef = useRef<Map<string, string>>(new Map());

  const setEntry = (key: string, patch: (e: Entry) => Entry) =>
    setEntries((prev) => prev.map((e) => (e.key === key ? patch(e) : e)));

  const pump = useCallback(() => {
    while (inFlightRef.current < AI_CONCURRENCY && queueRef.current.length > 0) {
      const now = Date.now();
      // Drop starts older than the sliding window.
      callTimesRef.current = callTimesRef.current.filter((t) => now - t < 60000);
      if (callTimesRef.current.length >= AI_MAX_PER_MIN) {
        // Budget spent — resume when the oldest call ages out of the window.
        setTimeout(pump, 60000 - (now - callTimesRef.current[0]) + 100);
        return;
      }
      const key = queueRef.current.shift();
      if (!key) return;
      const image = imagesRef.current.get(key);
      if (!image) continue;
      callTimesRef.current.push(now);
      inFlightRef.current += 1;
      startExtraction(key, image);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const startExtraction = useCallback((key: string, image: string) => {
    setEntry(key, (e) => ({ ...e, status: "extracting" }));
    extractCheque(image)
      .then((res) => {
        if (res.ok && res.fields) {
          const f = res.fields;
          setEntry(key, (e) => {
            const merged = { ...e.fields };
            // Only fill fields the manager hasn't already typed.
            for (const [k, v] of Object.entries(f)) {
              if (v && !String(merged[k as keyof ChequeFields] ?? "").trim()) {
                merged[k as keyof ChequeFields] = v;
              }
            }
            // If we have an amount but no words, derive the words from the amount.
            if (String(merged.amount ?? "").trim() && !String(merged.amount_in_words ?? "").trim()) {
              merged.amount_in_words = amountToWords(merged.amount);
            }
            const status: ExtractStatus = res.source === "ocr" ? "ocr" : "ai";
            const note = res.source === "ocr" ? "via local OCR" : res.provider ? `via ${res.provider}` : undefined;
            return { ...e, fields: merged, status, note };
          });
        } else {
          setEntry(key, (e) => ({ ...e, status: "failed", note: res.error }));
        }
      })
      .catch(() => setEntry(key, (e) => ({ ...e, status: "failed", note: "extraction error" })))
      .finally(() => {
        inFlightRef.current -= 1;
        pump();
      });
  }, [pump]);

  const enqueue = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    queueRef.current.push(...keys);
    setEntries((prev) => prev.map((e) => (keys.includes(e.key) && e.image ? { ...e, status: "queued" } : e)));
    pump();
  }, [pump]);

  const addEntries = (items: Entry[]) => {
    for (const it of items) if (it.image) imagesRef.current.set(it.key, it.image);
    setEntries((prev) => [...prev, ...items]);
  };

  /**
   * Straighten a page using Tesseract orientation detection on the sidecar.
   * Runs in the background so it never holds up rendering or extraction; the
   * image simply snaps upright a moment after it appears.
   */
  const straighten = useCallback((key: string, image: string) => {
    detectRotation(image)
      .then(async (deg) => {
        if (!deg) return;
        const fixed = await rotateDataUrl(image, deg);
        imagesRef.current.set(key, fixed);
        setEntry(key, (e) => ({ ...e, image: fixed }));
      })
      .catch(() => {});
  }, []);

  /** Read image/PDF files entirely in the browser → one Entry per page/image. */
  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setError(undefined); setOkMsg(undefined);
    const list = Array.from(files);
    if (list.length === 0) return;

    let pdfjs: typeof import("pdfjs-dist") | null = null;
    const total = list.length;
    let done = 0;
    const newKeys: string[] = [];

    for (const file of list) {
      done++;
      try {
        if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
          setRendering(`Reading PDF ${done}/${total}: ${file.name}…`);
          if (!pdfjs) {
            pdfjs = await import("pdfjs-dist");
            pdfjs.GlobalWorkerOptions.workerSrc = new URL(
              "pdfjs-dist/build/pdf.worker.min.mjs",
              import.meta.url
            ).toString();
          }
          const buf = await file.arrayBuffer();
          const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
          for (let p = 1; p <= pdf.numPages; p++) {
            setRendering(`Rendering ${file.name} — page ${p}/${pdf.numPages}…`);
            const page = await pdf.getPage(p);
            const base = page.getViewport({ scale: 1 });
            const scale = Math.min(1400 / base.width, 2);
            const vp = page.getViewport({ scale });
            const canvas = document.createElement("canvas");
            canvas.width = Math.floor(vp.width);
            canvas.height = Math.floor(vp.height);
            const ctx = canvas.getContext("2d");
            if (!ctx) continue;
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
            const key = nextKey();
            const image = landscapeDataUrl(canvas);
            // Show each page the moment it's ready rather than after the whole
            // PDF — a long document used to look frozen until the last page.
            addEntries([{ key, image, fields: { received_date: todayStr() }, status: "idle" }]);
            newKeys.push(key);
            straighten(key, image);
            // Let the browser paint between pages.
            await new Promise((r) => setTimeout(r, 0));
          }
        } else if (file.type.startsWith("image/")) {
          setRendering(`Loading image ${done}/${total}: ${file.name}…`);
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.onerror = () => reject(new Error("read failed"));
            r.readAsDataURL(file);
          });
          const key = nextKey();
          const image = await toLandscape(dataUrl);
          addEntries([{ key, image, fields: { received_date: todayStr() }, status: "idle" }]);
          newKeys.push(key);
          straighten(key, image);
        } else {
          setError(`Skipped ${file.name} — only PDF or image files are supported.`);
        }
      } catch (e) {
        setError(`Couldn't read ${file.name}: ${e instanceof Error ? e.message : "unknown error"}`);
      }
    }
    setRendering(null);
    if (fileRef.current) fileRef.current.value = "";
    // Extraction always runs: AI first, then local OCR, then manual entry.
    enqueue(newKeys);
  }, [enqueue]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
  };

  const setField = (key: string, name: keyof ChequeFields, value: string) =>
    setEntry(key, (e) => {
      const fields = { ...e.fields, [name]: value };
      // Editing the amount auto-rewrites the words.
      if (name === "amount") fields.amount_in_words = amountToWords(value);
      return { ...e, fields };
    });

  /** Manual straightening — used when the automatic guess is off. */
  const rotateEntry = async (key: string, deg: number) => {
    const current = imagesRef.current.get(key);
    if (!current) return;
    const fixed = await rotateDataUrl(current, deg);
    imagesRef.current.set(key, fixed);
    setEntry(key, (e) => ({ ...e, image: fixed }));
  };

  /** Drop one or more pending cheques (never touches anything already saved). */
  const removeEntries = (keys: string[]) => {
    if (keys.length === 0) return;
    const drop = new Set(keys);
    for (const k of drop) imagesRef.current.delete(k);
    queueRef.current = queueRef.current.filter((k) => !drop.has(k));
    setEntries((prev) => prev.filter((e) => !drop.has(e.key)));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of drop) next.delete(k);
      return next;
    });
  };

  const removeEntry = (key: string) => removeEntries([key]);

  const removeSelected = () => removeEntries([...selected]);

  const removeAll = () => {
    if (entries.length > 1 && !window.confirm(`Remove all ${entries.length} cheques? Nothing has been saved yet.`)) return;
    removeEntries(entries.map((e) => e.key));
  };

  const toggleSelect = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleSelectAll = () =>
    setSelected((prev) => (prev.size === entries.length ? new Set() : new Set(entries.map((e) => e.key))));

  // Cheques in THIS batch that repeat an earlier one (same physical cheque:
  // IFSC/MICR + account + cheque number). The later occurrence is flagged so it
  // can be removed. The server enforces this too, plus the already-in-system check.
  const dupEntryKeys = useMemo(() => {
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const e of entries) {
      const keys = chequeIdentityKeys(e.fields);
      if (keys.length === 0) continue;
      if (keys.some((k) => seen.has(k))) dups.add(e.key);
      for (const k of keys) seen.add(k);
    }
    return dups;
  }, [entries]);

  // Declared here (rather than further down) because the duplicate check below
  // must wait for extraction to finish before reading the fields.
  const extracting = entries.filter((e) => e.status === "queued" || e.status === "extracting").length;

  /**
   * Cheques that already exist in the system (submitted / presented / passed).
   * Checked on the server the moment extraction settles, so a duplicate is
   * flagged before the user commits rather than being rejected after saving.
   * Bounced cheques do not appear here — those may be presented again.
   */
  const [knownDupKeys, setKnownDupKeys] = useState<Set<string>>(new Set());
  const [checkingDups, setCheckingDups] = useState(false);

  useEffect(() => {
    // Wait for extraction to settle: fields change as each cheque is read, and
    // checking mid-flight would flag on half-populated values.
    if (extracting > 0 || entries.length === 0) {
      if (entries.length === 0) setKnownDupKeys(new Set());
      return;
    }
    let cancelled = false;
    setCheckingDups(true);
    const list = entries.map((e) => e.fields);
    findKnownDuplicates(list)
      .then((hits) => {
        if (cancelled) return;
        setKnownDupKeys(new Set(hits.map((i) => entries[i]?.key).filter(Boolean) as string[]));
      })
      .catch(() => {
        // Never block saving because the check itself failed — the server-side
        // guard in saveCheques is the real control and still runs.
        if (!cancelled) setKnownDupKeys(new Set());
      })
      .finally(() => !cancelled && setCheckingDups(false));
    return () => { cancelled = true; };
    // Re-run when the identity fields change, not on every keystroke elsewhere.
  }, [extracting, entries.map((e) => chequeIdentityKeys(e.fields).join(",")).join(";")]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Anything that must be removed before saving: in-batch or already banked. */
  const blockedKeys = useMemo(
    () => new Set<string>([...dupEntryKeys, ...knownDupKeys]),
    [dupEntryKeys, knownDupKeys]
  );

  const blockTitle =
    knownDupKeys.size > 0
      ? "Remove the cheque(s) already in the system first"
      : dupEntryKeys.size > 0
        ? "Remove the duplicate cheque(s) first"
        : checkingDups
          ? "Checking for duplicates…"
          : extracting > 0
            ? "Waiting for extraction to finish"
            : undefined;

  const save = async (submit: boolean) => {
    setError(undefined); setOkMsg(undefined);
    if (entries.length === 0) return;
    if (blockedKeys.size > 0) {
      setError(
        knownDupKeys.size > 0
          ? "Some cheques are already in the system and not bounced. Remove the ones marked below, then save."
          : "The same cheque appears more than once in this upload (matched on bank + account + cheque number). Remove the duplicate(s) marked below, then save."
      );
      return;
    }
    if (submit && entries.some((e) => chequeMissingRequired(e.fields))) {
      setError("Every cheque needs a cheque number, a positive amount, and a dealer name before submitting.");
      return;
    }
    setSaving(true);
    const res = await createCheques(entries.map((e) => e.fields), submit);
    setSaving(false);
    if (res.error) {
      setError(`${res.error}${res.count ? ` (${res.count} saved before the error)` : ""}`);
      return;
    }
    imagesRef.current.clear();
    queueRef.current = [];
    setEntries([]);
    setSelected(new Set());
    setOkMsg(`${res.count} cheque${res.count === 1 ? "" : "s"} ${submit ? "submitted" : "saved as draft"}.`);
    router.refresh();
  };

  return (
    <div className="space-y-4">
      <FormError message={error} />
      {okMsg && <FormOk message={okMsg} />}

      <div
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        className="rounded-[var(--radius)] border-2 border-dashed border-line bg-[var(--color-surface-2)] px-4 py-8 text-center"
      >
        <p className="text-sm text-muted">
          Drop scanned cheques here — <span className="font-medium text-ink">PDF</span> (one cheque per page) or images.
          Files stay in your browser; only the fields are saved.
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="application/pdf,image/*"
            className="hidden"
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
          />
          <button type="button" className={BTN_PRIMARY} onClick={() => fileRef.current?.click()} disabled={!!rendering}>
            Choose files
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">
          Fields are filled automatically — AI first, local OCR if AI is unavailable, otherwise enter them by hand.
        </p>
        {rendering && <p className="mt-2 text-xs text-[var(--color-info)]">{rendering}</p>}
        {extracting > 0 && (
          <p className="mt-2 text-xs text-[var(--color-info)]">
            AI extracting… {extracting} to go.
          </p>
        )}
      </div>

      {entries.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm text-muted">
              <input
                type="checkbox"
                checked={entries.length > 0 && selected.size === entries.length}
                ref={(el) => { if (el) el.indeterminate = selected.size > 0 && selected.size < entries.length; }}
                onChange={toggleSelectAll}
              />
              {selected.size > 0
                ? `${selected.size} of ${entries.length} selected`
                : `${entries.length} cheque${entries.length === 1 ? "" : "s"} ready to enter`}
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={BTN_DANGER}
                onClick={removeSelected}
                disabled={saving || selected.size === 0}
              >
                Remove selected{selected.size > 0 ? ` (${selected.size})` : ""}
              </button>
              <button type="button" className={BTN_DANGER} onClick={removeAll} disabled={saving}>
                Remove all
              </button>
              <button
                type="button"
                className={BTN_DEFAULT}
                onClick={() => save(false)}
                disabled={saving || extracting > 0 || checkingDups || blockedKeys.size > 0}
                title={blockTitle}
              >
                {saving ? "Saving…" : "Save all as drafts"}
              </button>
              <button
                type="button"
                className={BTN_PRIMARY}
                onClick={() => save(true)}
                disabled={saving || extracting > 0 || checkingDups || blockedKeys.size > 0}
                title={blockTitle}
              >
                {saving
                  ? "Saving…"
                  : extracting > 0
                    ? `Extracting… ${extracting} left`
                    : checkingDups
                      ? "Checking for duplicates…"
                      : "Save & submit all"}
              </button>
            </div>
          </div>

          {knownDupKeys.size > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-[var(--color-danger)]">
              <span className="font-medium">
                {knownDupKeys.size} cheque{knownDupKeys.size === 1 ? " is" : "s are"} already in the system
              </span>{" "}
              and not bounced — {knownDupKeys.size === 1 ? "it has" : "they have"} already been submitted,
              presented or passed. Remove {knownDupKeys.size === 1 ? "it" : "them"} — marked below — before saving.
              Only a bounced cheque may be entered again.
            </div>
          )}

          {dupEntryKeys.size > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-[var(--color-danger)]">
              {dupEntryKeys.size} cheque{dupEntryKeys.size === 1 ? " is a" : "s are"} duplicate{dupEntryKeys.size === 1 ? "" : "s"} of another in this upload
              (same bank, account and cheque number). Remove {dupEntryKeys.size === 1 ? "it" : "them"} — marked below — before saving.
            </div>
          )}

          {entries.map((en, i) => {
            const chip = STATUS_CHIP[en.status];
            return (
              <Card key={en.key} className="p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selected.has(en.key)}
                      onChange={() => toggleSelect(en.key)}
                      title="Select this cheque"
                    />
                    <span className="text-xs font-semibold text-faint">CHEQUE {i + 1}</span>
                    {chip && (
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${chip.cls}`}>{chip.label}</span>
                    )}
                    {knownDupKeys.has(en.key) && (
                      <span
                        className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-[var(--color-danger)]"
                        title="This cheque is already in the system and has not bounced"
                      >
                        Already in system — remove
                      </span>
                    )}
                    {dupEntryKeys.has(en.key) && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-[var(--color-danger)]">
                        Duplicate — remove
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {en.image && (
                      <span className="flex items-center gap-1">
                        <button
                          type="button"
                          title="Rotate left"
                          onClick={() => rotateEntry(en.key, -90)}
                          className="rounded border border-line px-1.5 py-0.5 text-xs text-muted hover:bg-[var(--color-surface-2)] hover:text-ink"
                        >
                          ↺
                        </button>
                        <button
                          type="button"
                          title="Rotate right"
                          onClick={() => rotateEntry(en.key, 90)}
                          className="rounded border border-line px-1.5 py-0.5 text-xs text-muted hover:bg-[var(--color-surface-2)] hover:text-ink"
                        >
                          ↻
                        </button>
                        <button
                          type="button"
                          title="Flip 180°"
                          onClick={() => rotateEntry(en.key, 180)}
                          className="rounded border border-line px-1.5 py-0.5 text-xs text-muted hover:bg-[var(--color-surface-2)] hover:text-ink"
                        >
                          ⤢
                        </button>
                      </span>
                    )}
                    {en.image && en.status !== "queued" && en.status !== "extracting" && (
                      <button
                        type="button"
                        onClick={() => enqueue([en.key])}
                        className="text-xs text-brand hover:underline"
                      >
                        {en.status === "idle" ? "Extract with AI" : "Re-extract"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => removeEntry(en.key)}
                      className="text-xs text-[var(--color-danger)] hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {en.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={en.image}
                    alt={`Cheque ${i + 1}`}
                    className="mb-3 w-full max-h-[26rem] rounded border border-line bg-[var(--color-surface-2)] object-contain"
                  />
                )}

                <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
                  {FIELDS.map((f) => (
                    <label key={f.name} className={f.wide ? "col-span-2 sm:col-span-3 lg:col-span-4" : ""}>
                      <span className={labelClass}>
                        {f.label}
                        {f.req && <span className="text-[var(--color-danger)]"> *</span>}
                      </span>
                      <input
                        type={f.type ?? "text"}
                        step={f.type === "number" ? "0.01" : undefined}
                        value={en.fields[f.name] ?? ""}
                        onChange={(e) => setField(en.key, f.name, e.target.value)}
                        className={inputClass}
                      />
                    </label>
                  ))}
                </div>
              </Card>
            );
          })}
        </>
      )}
    </div>
  );
}

"use client";

import { useMemo, useState, useTransition } from "react";
import { Button, FormError, FormOk, Table, Th, Td } from "@/components/ui";
import { saveSettings, type SettingValue, type SettingsFormState } from "./actions";

export type SettingRow = {
  key: string;
  value: unknown;
  description: string | null;
  updated_at: string | null;
};

type Kind = "boolean" | "string" | "number";

const inputClass = "mt-0 w-full rounded border border-line px-2 py-1 text-sm";

function kindOf(v: unknown): Kind {
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  return "string";
}

/** JSON value -> the string shown in the input. */
function toEditString(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  return v == null ? "" : String(v);
}

/** Input string -> the correctly typed JSON value for the jsonb column. */
function toValue(raw: string, kind: Kind): SettingValue {
  if (kind === "boolean") return raw === "true";
  if (kind === "number") return Number(raw);
  return raw;
}

export function SettingsForm({ settings }: { settings: SettingRow[] }) {
  const kinds = useMemo(
    () => Object.fromEntries(settings.map((s) => [s.key, kindOf(s.value)])) as Record<string, Kind>,
    [settings]
  );

  const initial = useMemo(
    () => Object.fromEntries(settings.map((s) => [s.key, toEditString(s.value)])) as Record<string, string>,
    [settings]
  );

  const [values, setValues] = useState<Record<string, string>>(initial);
  const [baseline, setBaseline] = useState<Record<string, string>>(initial);
  const [state, setState] = useState<SettingsFormState>({});
  const [pending, startTransition] = useTransition();

  const dirtyKeys = settings.map((s) => s.key).filter((k) => values[k] !== baseline[k]);

  function set(key: string, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState({});

    const changes: { key: string; value: SettingValue }[] = [];
    for (const key of dirtyKeys) {
      const kind = kinds[key];
      if (kind === "number") {
        const raw = values[key].trim();
        if (raw === "" || Number.isNaN(Number(raw))) {
          setState({ error: `${key}: enter a valid number.` });
          return;
        }
      }
      changes.push({ key, value: toValue(values[key], kind) });
    }

    startTransition(async () => {
      const res = await saveSettings(changes);
      setState(res);
      if (!res.error) setBaseline(values);
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {state.error && <FormError message={state.error} />}
      {state.ok && !state.error && <FormOk message={state.ok} />}

      <Table
        head={
          <tr>
            <Th>Key</Th>
            <Th>Description</Th>
            <Th className="w-48">Value</Th>
          </tr>
        }
      >
        {settings.map((s) => {
          const kind = kinds[s.key];
          const dirty = values[s.key] !== baseline[s.key];
          return (
            <tr key={s.key} className={dirty ? "bg-amber-50" : undefined}>
              <Td className="font-medium align-top whitespace-nowrap">{s.key}</Td>
              <Td className="text-muted align-top">{s.description ?? ""}</Td>
              <Td className="align-top">
                {kind === "boolean" ? (
                  <select
                    value={values[s.key]}
                    onChange={(e) => set(s.key, e.target.value)}
                    className={inputClass}
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : kind === "number" ? (
                  <input
                    type="number"
                    step="any"
                    value={values[s.key]}
                    onChange={(e) => set(s.key, e.target.value)}
                    className={`${inputClass} tabular`}
                  />
                ) : (
                  <input
                    type="text"
                    value={values[s.key]}
                    onChange={(e) => set(s.key, e.target.value)}
                    className={inputClass}
                  />
                )}
              </Td>
            </tr>
          );
        })}
      </Table>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending || dirtyKeys.length === 0}>
          {pending ? "Saving…" : `Save changes${dirtyKeys.length ? ` (${dirtyKeys.length})` : ""}`}
        </Button>
        {dirtyKeys.length > 0 && !pending && (
          <span className="text-muted text-sm">{dirtyKeys.length} unsaved</span>
        )}
      </div>
    </form>
  );
}

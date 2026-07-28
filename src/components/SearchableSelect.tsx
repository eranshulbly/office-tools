"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type SelectOption = { value: string; label: string };

/**
 * A type-to-search combobox that submits like a normal form field (a hidden
 * <input name=...>). Uncontrolled internally; call `onChange` for any dependent
 * UI. To reset it after a submit, change its `key` so it remounts.
 */
export function SearchableSelect({
  name,
  options,
  defaultValue = "",
  placeholder = "Search…",
  required = false,
  onChange,
  className,
}: {
  name: string;
  options: SelectOption[];
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  onChange?: (value: string) => void;
  className?: string;
}) {
  const inputClass = className ?? "mt-1 w-full rounded-lg border border-line px-3 py-2.5 text-sm";
  const [value, setValue] = useState(defaultValue);
  const [query, setQuery] = useState(options.find((o) => o.value === defaultValue)?.label ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function choose(o: SelectOption) {
    setValue(o.value);
    setQuery(o.label);
    setOpen(false);
    onChange?.(o.value);
  }

  return (
    <div ref={rootRef} className="relative">
      <input type="hidden" name={name} value={value} />
      <input
        type="text"
        value={query}
        placeholder={placeholder}
        required={required && !value}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        onChange={(e) => {
          setQuery(e.target.value);
          if (value) {
            setValue("");
            onChange?.("");
          }
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            if (open && filtered[active]) {
              e.preventDefault();
              choose(filtered[active]);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        className={inputClass}
      />
      {open && (
        <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-line bg-surface shadow-[var(--shadow-sm)]">
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted">No match</li>
          ) : (
            filtered.map((o, i) => (
              <li
                key={o.value}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o);
                }}
                onMouseEnter={() => setActive(i)}
                className={`cursor-pointer px-3 py-1.5 text-sm text-ink ${
                  i === active ? "bg-[var(--color-brand-soft)]" : "hover:bg-[var(--color-surface-2)]"
                } ${o.value === value ? "font-medium" : ""}`}
              >
                {o.label}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

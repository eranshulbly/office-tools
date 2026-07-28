"use client";

import { useRouter } from "next/navigation";
import { SearchableSelect, type SelectOption } from "@/components/SearchableSelect";

/** Searchable employee picker that navigates to /statements?worker=<id>. */
export function EmployeePicker({
  employees,
  current,
}: {
  employees: SelectOption[];
  current: string;
}) {
  const router = useRouter();
  return (
    <div className="max-w-md">
      <label className="text-sm font-medium text-ink">Employee</label>
      <SearchableSelect
        name="worker"
        options={employees}
        defaultValue={current}
        placeholder="Search employee by name or code…"
        onChange={(value) => {
          if (value) router.push(`/statements?worker=${value}`);
        }}
      />
    </div>
  );
}

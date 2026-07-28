"use client";

import { useState } from "react";
import { Card, money } from "@/components/ui";
import type { ChequeFields } from "@/lib/types";
import { PresentForm, type PresentAccount } from "../PresentForm";
import { ChequeEditModal } from "../ChequeEditModal";
import type { PresentItem } from "./ReconLists";

function d(v: string | null): string {
  return v ? new Date(v).toLocaleDateString("en-IN") : "—";
}

/**
 * One "to present" cheque. First view shows only amount, dealer and cheque date;
 * everything else is fixed via the Edit modal (admin-only).
 */
export function PresentCard({
  item,
  accounts,
  defaultDate,
}: {
  item: PresentItem;
  accounts: PresentAccount[];
  defaultDate: string;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <Card className="flex flex-col gap-3 p-3 lg:flex-row lg:items-center lg:justify-between">
      {/* Summary takes the free space and WRAPS its own text instead of pushing
          the controls onto a new line — so every card lays out the same way. */}
      <div className="min-w-0 text-sm lg:flex-1">
        <div>
          <span className="font-semibold text-ink tabular">{item.amount != null ? money(item.amount) : "—"}</span>
          <span className="text-muted">
            {" "}· {item.dealer_name ?? "—"} · #{item.cheque_number ?? "—"} · dated {d(item.cheque_date)}
          </span>
        </div>
        {item.fields.notes?.trim() && (
          <div className="mt-1 text-xs text-muted">
            <span className="font-medium text-ink">Note:</span> {item.fields.notes}
          </div>
        )}
      </div>
      <div className="lg:shrink-0">
        <PresentForm
          id={item.id}
          accounts={accounts}
          defaultAccountId={item.defaultAccountId}
          defaultDate={defaultDate}
          onEdit={() => setEditing(true)}
        />
      </div>
      {editing && (
        <ChequeEditModal id={item.id} initial={item.fields} onClose={() => setEditing(false)} />
      )}
    </Card>
  );
}

export type { ChequeFields };

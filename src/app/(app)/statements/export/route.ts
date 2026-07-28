import { NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { buildLedger } from "../ledger";

export const dynamic = "force-dynamic";

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: NextRequest) {
  const profile = await getProfile();
  if (!profile || profile.role !== "admin") {
    return NextResponse.json({ error: "Admins only." }, { status: 403 });
  }

  const supabase = await createSupabaseServerClient();
  const worker = new URL(req.url).searchParams.get("worker");
  const single = worker && worker !== "all" ? worker : null;

  const { rows } = await buildLedger(supabase, single);

  const header = [
    "Date", "Employee code", "Employee", "Type", "Details",
    "Paid to employee", "Advance recovered", "Outstanding advance",
  ];
  const lines = [
    header.map(csvCell).join(","),
    ...rows.map((r) =>
      [
        r.date.slice(0, 10),
        r.code,
        r.name,
        r.kind === "advance" ? "Advance" : "Salary",
        r.details,
        r.paid.toFixed(2),
        r.recovered ? r.recovered.toFixed(2) : "",
        r.balanceAfter.toFixed(2),
      ].map(csvCell).join(",")
    ),
  ];
  const csv = "﻿" + lines.join("\r\n"); // BOM so Excel reads UTF-8

  const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const who = single ? "employee" : "all";
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="employee-ledger-${who}-${stamp}.csv"`,
    },
  });
}

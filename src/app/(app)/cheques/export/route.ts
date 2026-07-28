import { NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Cheque, CompanyBankAccount } from "@/lib/types";
import { CHEQUE_STATUS_META } from "@/lib/cheque";

export const dynamic = "force-dynamic";

const COLUMNS: { header: string; get: (c: Cheque, ctx: Ctx) => string }[] = [
  { header: "Status", get: (c) => CHEQUE_STATUS_META[c.status].label },
  { header: "Cheque no.", get: (c) => c.cheque_number ?? "" },
  { header: "Cheque date", get: (c) => c.cheque_date ?? "" },
  { header: "Received on", get: (c) => c.received_date ?? "" },
  { header: "Amount", get: (c) => (c.amount != null ? String(c.amount) : "") },
  { header: "Amount in words", get: (c) => c.amount_in_words ?? "" },
  { header: "Dealer", get: (c) => c.dealer_name ?? "" },
  { header: "Drawee bank", get: (c) => c.bank_name ?? "" },
  { header: "Branch", get: (c) => c.branch ?? "" },
  { header: "IFSC", get: (c) => c.ifsc ?? "" },
  { header: "Account no.", get: (c) => c.account_number ?? "" },
  { header: "MICR", get: (c) => c.micr_code ?? "" },
  { header: "Payee", get: (c) => c.payee_name ?? "" },
  { header: "Uploaded by", get: (c, ctx) => (c.uploaded_by ? ctx.names.get(c.uploaded_by) ?? "" : "") },
  { header: "Uploaded", get: (c) => (c.upload_date ? c.upload_date.slice(0, 10) : "") },
  { header: "Submitted", get: (c) => (c.submitted_at ? c.submitted_at.slice(0, 10) : "") },
  { header: "Decided", get: (c) => (c.decided_at ? c.decided_at.slice(0, 10) : "") },
  { header: "Rejection reason", get: (c) => (c.status === "rejected" ? c.decision_reason ?? "" : "") },
  { header: "Presented to", get: (c, ctx) => (c.our_bank_account_id ? ctx.banks.get(c.our_bank_account_id) ?? "" : "") },
  { header: "Presented on", get: (c) => c.presented_date ?? "" },
  { header: "Cleared/Bounced on", get: (c) => c.cleared_date ?? "" },
  { header: "Bounce reason", get: (c) => c.bounce_reason ?? "" },
  { header: "Notes", get: (c) => c.notes ?? "" },
];

type Ctx = { names: Map<string, string>; banks: Map<string, string> };

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export async function GET(req: NextRequest) {
  const profile = await getProfile();
  if (!profile || profile.role !== "admin") {
    return NextResponse.json({ error: "Admins only." }, { status: 403 });
  }
  const supabase = await createSupabaseServerClient();
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  let q = supabase.from("cheques").select("*").order("created_at", { ascending: false });
  if (status) q = q.eq("status", status);
  if (from) q = q.gte("cheque_date", from);
  if (to) q = q.lte("cheque_date", to);

  const [chequesRes, profilesRes, banksRes] = await Promise.all([
    q,
    supabase.from("profiles").select("id, full_name"),
    supabase.from("company_bank_accounts").select("id, label"),
  ]);
  if (chequesRes.error) {
    return NextResponse.json({ error: chequesRes.error.message }, { status: 500 });
  }

  const ctx: Ctx = {
    names: new Map((profilesRes.data ?? []).map((p) => [p.id as string, p.full_name as string])),
    banks: new Map((banksRes.data ?? []).map((b) => [(b as CompanyBankAccount).id, (b as CompanyBankAccount).label])),
  };
  const rows = (chequesRes.data ?? []) as Cheque[];

  const lines = [
    COLUMNS.map((c) => csvCell(c.header)).join(","),
    ...rows.map((r) => COLUMNS.map((c) => csvCell(c.get(r, ctx))).join(",")),
  ];
  const csv = "﻿" + lines.join("\r\n"); // BOM so Excel reads UTF-8

  const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="cheques-${status ?? "all"}-${stamp}.csv"`,
    },
  });
}

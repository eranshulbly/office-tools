"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { listFirms, firmCookie, FIRM_PICKER_PATH } from "@/lib/firm";
import { payeeKey } from "@/lib/cheque";

/**
 * Select the firm the cheque suite is scoped to.
 *
 * Validated against the live firm list rather than trusted from the form — the
 * cookie decides which books you see and which firm new cheques are filed
 * under, so an arbitrary value must not be settable.
 */
export async function selectFirm(name: string, next?: string): Promise<void> {
  const firms = await listFirms();
  const match = firms.find((f) => f.key === payeeKey(name));
  if (!match) redirect("/s/cheque");

  const jar = await cookies();
  jar.set(firmCookie.name, match.name, firmCookie.options);

  // Every cheque page is firm-dependent, so drop cached renders for the suite.
  revalidatePath("/cheques", "layout");
  redirect(next && next.startsWith("/cheques") ? next : "/cheques");
}

/** Clear the selection and go back to the picker. */
export async function clearFirm(): Promise<void> {
  const jar = await cookies();
  jar.set(firmCookie.name, "", { ...firmCookie.options, maxAge: 0 });
  revalidatePath("/cheques", "layout");
  redirect(FIRM_PICKER_PATH);
}

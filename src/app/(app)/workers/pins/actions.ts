"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type PinActionState = { error?: string; ok?: boolean };

/**
 * Assign (or clear, with pin = null) a worker's biometric device PIN. The PIN is
 * the User ID enrolled on the terminal — it's how a punch is tied to a person.
 * Assigning one also backfills that person's earlier unlinked punches, because
 * dedupe_punch_times matches unlinked punches by PIN (migration 0029).
 */
export async function setDevicePin(workerId: string, pin: number | null): Promise<PinActionState> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("admin_set_device_pin", { p_worker: workerId, p_pin: pin });
  if (error) return { error: error.message };
  revalidatePath("/workers/pins");
  revalidatePath("/workers");
  return { ok: true };
}

/**
 * Ask the terminal to upload its enrolled-user list (User ID + name). The
 * gateway runs on this same box, so we queue the ADMS command on its localhost
 * admin port; the device picks it up on its next poll (a few seconds) and the
 * device_users table is refreshed by the gateway.
 */
export async function syncDeviceUsers(serial: string): Promise<PinActionState> {
  const base = process.env.GATEWAY_ADMIN_URL || "http://127.0.0.1:8080";
  try {
    const resp = await fetch(
      `${base}/admin/cmd?sn=${encodeURIComponent(serial)}&cmd=${encodeURIComponent("DATA QUERY USERINFO")}`,
      { method: "POST", signal: AbortSignal.timeout(8000), cache: "no-store" }
    );
    if (!resp.ok) return { error: `Gateway refused the request (HTTP ${resp.status}).` };
    return { ok: true };
  } catch {
    return { error: "Couldn't reach the attendance gateway. Is it running?" };
  }
}

/** Recompute attendance for a date range so newly-linked punches take effect. */
export async function recomputeRange(from: string, to: string): Promise<PinActionState> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("recompute_attendance", { from_date: from, to_date: to });
  if (error) return { error: error.message };
  revalidatePath("/attendance");
  return { ok: true };
}

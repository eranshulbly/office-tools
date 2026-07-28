import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * DEFERRED SMS-on-disbursal hook. Safe no-op today: it reads the `sms_enabled`
 * setting and the worker's phone, and — when enabled — logs where a real SMS
 * would be sent. It NEVER throws; callers can `await` it without guarding.
 *
 * TODO(sms): plug an SMS provider here (e.g. MSG91 or Twilio). Read credentials
 * from env, POST the disbursal message to `phone`, and record the result.
 * NOTE: sending transactional SMS to Indian numbers requires DLT registration
 * (registered sender ID + approved DLT template id) with the telecom operators;
 * the provider call must pass those. Until that is set up, keep sms_enabled=false.
 */
export async function notifyDisbursal(workerId: string): Promise<void> {
  try {
    const supabase = await createSupabaseServerClient();

    const [{ data: setting }, { data: worker }] = await Promise.all([
      supabase.from("settings").select("value").eq("key", "sms_enabled").single(),
      supabase.from("workers").select("phone").eq("id", workerId).single(),
    ]);

    // settings.value is jsonb; a boolean true means SMS is turned on.
    const smsEnabled = setting?.value === true;
    const phone = (worker?.phone as string | null | undefined) ?? null;

    if (!smsEnabled || !phone) return;

    // TODO(sms): replace this log with the actual provider call (see file header).
    console.log(`[notify] (disabled) would SMS ${phone} about disbursal`);
  } catch (err) {
    // A notification must never affect the disbursal. Swallow everything.
    console.error("[notify] notifyDisbursal failed (ignored):", err);
  }
}

"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** A setting value is always one of these JSON scalar types. */
export type SettingValue = string | number | boolean;

export type SettingsFormState = { error?: string; ok?: string };

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/**
 * Validate a setting value before it is written. A bad value (e.g. a non-time
 * cutoff, or a non-numeric threshold) must never be persisted — a malformed
 * value would otherwise break attendance recompute / payroll for everyone.
 * Returns an error message, or null when valid.
 */
function validateSetting(key: string, value: SettingValue): string | null {
  // Keys that must be a valid HH:MM(:SS) time.
  if (key === "late_first_punch_cutoff" || key === "punch_in_only_default_out") {
    if (typeof value !== "string" || !TIME_RE.test(value.trim())) {
      return "Cutoff must be a time in HH:MM (24-hour) format, e.g. 22:00.";
    }
    return null;
  }
  // Numeric thresholds.
  const numericKeys = new Set([
    "full_day_hours",
    "break_deduction_minutes",
    "dedupe_window_minutes",
    "free_leave_units",
    "daily_rate_divisor",
    "advance_cap_multiple",
    "manual_entry_alert_threshold",
    "device_offline_alert_hours",
    "clock_drift_alert_minutes",
  ]);
  if (numericKeys.has(key)) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n < 0) return `${key} must be a number ≥ 0.`;
    return null;
  }
  // Boolean flags.
  if (key === "overtime_enabled" || key === "extra_day_absence_counts_as_leave" || key === "sms_enabled") {
    if (typeof value !== "boolean") return `${key} must be true or false.`;
    return null;
  }
  return null;
}

/**
 * Update a single setting. The value is written back to the jsonb column with
 * its correct JSON type — a number stays a number, a boolean stays a boolean,
 * a string is stored as a JSON string. supabase-js serialises the JS value as
 * JSON, so passing the typed value is exactly right for a jsonb column.
 */
export async function updateSetting(
  key: string,
  value: SettingValue
): Promise<SettingsFormState> {
  const invalid = validateSetting(key, value);
  if (invalid) return { error: invalid };

  const profile = await requireRole("admin");
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase
    .from("settings")
    .update({ value, updated_by: profile.id, updated_at: new Date().toISOString() })
    .eq("key", key);

  if (error) return { error: error.message };
  revalidatePath("/settings");
  return { ok: "Saved." };
}

/**
 * Bulk-save changed rows. Applies each change with the same admin/updated_by
 * stamp; stops and surfaces the first error verbatim.
 */
export async function saveSettings(
  changes: { key: string; value: SettingValue }[]
): Promise<SettingsFormState> {
  if (changes.length === 0) return { ok: "No changes to save." };

  for (const c of changes) {
    const invalid = validateSetting(c.key, c.value);
    if (invalid) return { error: invalid };
  }

  const profile = await requireRole("admin");
  const supabase = await createSupabaseServerClient();
  const now = new Date().toISOString();

  for (const c of changes) {
    const { error } = await supabase
      .from("settings")
      .update({ value: c.value, updated_by: profile.id, updated_at: now })
      .eq("key", c.key);
    if (error) return { error: `${c.key}: ${error.message}` };
  }

  revalidatePath("/settings");
  return {
    ok: `Saved ${changes.length} setting${changes.length === 1 ? "" : "s"}.`,
  };
}

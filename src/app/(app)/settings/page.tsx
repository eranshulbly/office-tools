import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageHeader, FormError, Empty } from "@/components/ui";
import { SettingsForm, type SettingRow } from "./SettingsForm";

export default async function SettingsPage() {
  await requireRole("admin");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("settings")
    .select("key, value, description, updated_at")
    .order("key");

  const settings = (data ?? []) as SettingRow[];

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Business-rule thresholds. Numbers, booleans, and the warehouse timezone. Edit inline, then save."
      />

      {error && <FormError message={error.message} />}

      {settings.length === 0 ? (
        <Empty>No settings found.</Empty>
      ) : (
        <SettingsForm settings={settings} />
      )}
    </div>
  );
}

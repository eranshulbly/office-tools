import { requireFeature } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Worker } from "@/lib/types";
import { PageHeader, LinkButton } from "@/components/ui";
import { DevicePins, type PinWorker, type UnlinkedPin, type DeviceUser } from "./DevicePins";

export const dynamic = "force-dynamic";

export default async function DevicePinsPage() {
  await requireFeature("device-pins");
  const supabase = await createSupabaseServerClient();

  const [workersRes, unlinkedRes, deviceUsersRes, devicesRes] = await Promise.all([
    supabase
      .from("workers")
      .select("id, employee_code, full_name, device_user_id, is_active, approval_status")
      .eq("approval_status", "active")
      .order("full_name"),
    supabase.rpc("unlinked_punch_pins"),
    supabase.from("device_users").select("device_serial, pin, name, updated_at").order("pin"),
    supabase.from("devices").select("serial_number, last_seen_at").not("last_seen_at", "is", null)
      .order("last_seen_at", { ascending: false }),
  ]);

  const workers = ((workersRes.data ?? []) as Worker[]).map((w): PinWorker => ({
    id: w.id,
    employee_code: w.employee_code,
    full_name: w.full_name,
    device_user_id: w.device_user_id,
    is_active: w.is_active,
  }));
  const unlinked = (unlinkedRes.data ?? []) as UnlinkedPin[];
  const deviceUsers = (deviceUsersRes.data ?? []) as DeviceUser[];
  // The terminal we ask for the user list — the most recently seen one.
  const serial = (devicesRes.data ?? [])[0]?.serial_number as string | undefined;

  return (
    <div>
      <PageHeader
        title="Device PINs"
        subtitle="The attendance terminal only knows a numeric User ID (PIN). Map each employee to the PIN enrolled for them on the machine, or their punches can't be counted."
        actions={<LinkButton href="/workers">Back to employees</LinkButton>}
      />
      <DevicePins
        workers={workers}
        unlinked={unlinked}
        deviceUsers={deviceUsers}
        serial={serial}
        error={workersRes.error?.message ?? unlinkedRes.error?.message}
      />
    </div>
  );
}

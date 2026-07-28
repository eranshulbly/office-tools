import { requireProfile } from "@/lib/auth";
import { suitesForRole, firstFeatureHref, suiteComingSoon } from "@/lib/suites";
import { SuiteTile } from "@/components/Tiles";

/**
 * Home — the product launcher. A grid of high-level suite tiles (HR System,
 * Payroll, Cheque Reconciliation…). Which appear is decided by the signed-in
 * user's role via the suite registry (src/lib/suites.ts). Add a product there
 * and a new tile shows up here. Database RLS is the real access gate.
 */
export default async function HomePage() {
  const profile = await requireProfile();
  const suites = suitesForRole(profile.role, profile.full_access);
  const firstName = profile.full_name.split(" ")[0];

  return (
    <div className="rise">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Welcome back, {firstName}
        </h1>
        <p className="text-muted mt-1">
          Signed in as <span className="font-medium capitalize">{profile.role}</span>. Choose a
          system to get started.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {suites.map((s) => {
          const cs = suiteComingSoon(s, profile.role, profile.full_access);
          return (
            <SuiteTile
              key={s.key}
              suite={s}
              comingSoon={cs}
              href={cs ? undefined : firstFeatureHref(s.key, profile.role, profile.full_access)}
            />
          );
        })}
      </div>
    </div>
  );
}

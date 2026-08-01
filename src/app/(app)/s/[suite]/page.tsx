import { notFound, redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { suiteByKey, featuresForSuite, suiteComingSoon } from "@/lib/suites";
import { Empty } from "@/components/ui";
import { FIRM_PICKER_PATH } from "@/lib/firm";

export const dynamic = "force-dynamic";

/**
 * Suite entry point. There is no intermediate tile grid — selecting a product
 * jumps straight to its first tab and navigation continues via the tab bar.
 * This route just resolves that destination (or shows "coming soon").
 */
export default async function SuitePage({
  params,
}: {
  params: Promise<{ suite: string }>;
}) {
  const { suite: suiteKey } = await params;
  const suite = suiteByKey(suiteKey);
  if (!suite) notFound();

  const profile = await requireProfile();

  if (suiteComingSoon(suite, profile.role, profile.full_access)) {
    return (
      <div className="rise">
        <div className="flex items-center gap-4 mb-7">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl text-3xl bg-[var(--color-info-soft)]">
            {suite.icon}
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">{suite.title}</h1>
            <p className="text-muted mt-0.5">{suite.description}</p>
          </div>
        </div>
        <Empty>
          <div className="text-base font-medium text-ink mb-1">Coming soon</div>
          This module hasn&apos;t been built yet.
        </Empty>
      </div>
    );
  }

  // The cheque suite is scoped to one firm at a time, so entering it lands on
  // the firm picker rather than the first tab. That picker is a real route, so
  // Back and the "Change firm" link both return to the same place.
  if (suite.key === "cheque") redirect(FIRM_PICKER_PATH);

  const features = featuresForSuite(suite.key, profile.role, profile.full_access);
  if (features.length > 0) redirect(features[0].href);

  return <Empty>You don&apos;t have access to any tools in this system.</Empty>;
}

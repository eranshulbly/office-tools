import Link from "next/link";
import { ACCENT, type Suite, type Feature } from "@/lib/suites";
import { Badge } from "@/components/ui";

/** Large product tile for the home grid. `href` lands on the suite's first tab.
 * `comingSoon` overrides the suite's global flag (per-user gating). */
export function SuiteTile({ suite, href, comingSoon }: { suite: Suite; href?: string; comingSoon?: boolean }) {
  const accent = ACCENT[suite.accent];
  const isComingSoon = comingSoon ?? suite.comingSoon;
  const inner = (
    <div className="flex flex-col h-full gap-4">
      <div className="flex items-start justify-between">
        <span
          className="flex h-14 w-14 items-center justify-center rounded-2xl text-3xl"
          style={{ background: accent.soft }}
          aria-hidden
        >
          {suite.icon}
        </span>
        {isComingSoon && <Badge tone="neutral">Coming soon</Badge>}
      </div>
      <div>
        <div className="text-lg font-semibold text-ink">{suite.title}</div>
        <p className="text-muted text-sm mt-1 leading-relaxed">{suite.description}</p>
      </div>
      {!isComingSoon && (
        <div
          className="mt-auto text-sm font-medium inline-flex items-center gap-1"
          style={{ color: accent.fg }}
        >
          Open <span aria-hidden>→</span>
        </div>
      )}
    </div>
  );

  const cardBase =
    "group relative bg-surface border border-line rounded-2xl p-6 shadow-[var(--shadow-sm)] h-full";

  if (isComingSoon || !href) {
    return <div className={`${cardBase} opacity-70`}>{inner}</div>;
  }
  return (
    <Link
      href={href}
      className={`${cardBase} transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)] hover:border-line-strong`}
      style={{ ["--tw-ring-color" as string]: accent.fg }}
    >
      <span
        className="absolute inset-x-0 top-0 h-1 rounded-t-2xl opacity-0 group-hover:opacity-100 transition"
        style={{ background: accent.fg }}
      />
      {inner}
    </Link>
  );
}

/** Feature tile for a suite landing page. */
export function FeatureTile({ feature, accentFg }: { feature: Feature; accentFg?: string }) {
  return (
    <Link
      href={feature.href}
      className="group bg-surface border border-line rounded-[var(--radius)] p-4 shadow-[var(--shadow-sm)] transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)] hover:border-line-strong flex items-start gap-3"
    >
      <span className="text-2xl leading-none shrink-0" aria-hidden>
        {feature.icon}
      </span>
      <div className="min-w-0">
        <div
          className="font-semibold text-ink"
          style={accentFg ? { transitionProperty: "color" } : undefined}
        >
          {feature.title}
        </div>
        <div className="text-muted text-sm mt-0.5 leading-snug">{feature.description}</div>
      </div>
    </Link>
  );
}

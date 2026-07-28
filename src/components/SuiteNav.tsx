"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@/lib/types";
import { suiteForPath, featuresForSuite, featureForPath, firstFeatureHref, ACCENT } from "@/lib/suites";

/**
 * Contextual second bar. On the home page it shows nothing; inside a suite it
 * shows a breadcrumb back home and the suite's features as tabs, with the
 * current one highlighted in the suite's accent colour.
 */
export function SuiteNav({ role, fullAccess }: { role: Role; fullAccess: boolean }) {
  const pathname = usePathname() || "/";
  if (pathname === "/") return null;

  const suite = suiteForPath(pathname);
  if (!suite) return null;

  const features = featuresForSuite(suite.key, role, fullAccess);
  const active = featureForPath(pathname);
  const accent = ACCENT[suite.accent];

  return (
    <div className="border-b border-line bg-surface">
      <div className="max-w-6xl mx-auto px-4">
        <div className="flex items-center gap-2 h-9 text-xs text-muted">
          <Link href="/" className="hover:text-ink">
            Home
          </Link>
          <span className="text-faint">/</span>
          <Link href={firstFeatureHref(suite.key, role, fullAccess)} className="hover:text-ink font-medium">
            {suite.icon} {suite.title}
          </Link>
        </div>
        {features.length > 0 && (
          <nav className="flex items-center gap-1 overflow-x-auto -mb-px">
            {features.map((f) => {
              const isActive = active?.key === f.key;
              return (
                <Link
                  key={f.key}
                  href={f.href}
                  className="whitespace-nowrap px-3 py-2 text-sm border-b-2 transition-colors"
                  style={
                    isActive
                      ? { color: accent.fg, borderColor: accent.fg, fontWeight: 600 }
                      : { color: "var(--color-muted)", borderColor: "transparent" }
                  }
                >
                  {f.title}
                </Link>
              );
            })}
          </nav>
        )}
      </div>
    </div>
  );
}

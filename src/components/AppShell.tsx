import Link from "next/link";
import type { Profile } from "@/lib/types";
import { signOut } from "@/lib/actions/auth";
import { SuiteNav } from "@/components/SuiteNav";

/** App frame: brand bar + contextual suite nav + content. */
export function AppShell({ profile, children }: { profile: Profile; children: React.ReactNode }) {
  const initial = profile.full_name.trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-20 bg-surface/95 backdrop-blur border-b border-line">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2 font-semibold text-ink whitespace-nowrap">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-lg text-white text-sm"
              style={{ background: "var(--color-brand)" }}
            >
              WO
            </span>
            <span className="hidden sm:inline">Warehouse Ops</span>
          </Link>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex flex-col items-end leading-tight">
              <span className="text-sm font-medium text-ink">{profile.full_name}</span>
              <span className="text-xs text-muted capitalize">{profile.role}</span>
            </div>
            <span
              className="flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold text-white"
              style={{ background: "var(--color-brand-strong)" }}
              title={profile.full_name}
            >
              {initial}
            </span>
            <form action={signOut}>
              <button
                type="submit"
                className="text-sm text-muted hover:text-ink border border-line rounded-lg px-2.5 py-1.5 hover:bg-[var(--color-surface-2)] transition-colors"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
        <SuiteNav role={profile.role} fullAccess={profile.full_access} />
      </header>

      <main className="flex-1">
        <div className="max-w-6xl mx-auto px-4 py-7">{children}</div>
      </main>
    </div>
  );
}

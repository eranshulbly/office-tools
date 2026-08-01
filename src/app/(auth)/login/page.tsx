"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "./actions";

export default function LoginPage() {
  // useSearchParams (in LoginForm) requires a Suspense boundary to prerender.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.6 6.2A9.8 9.8 0 0 1 12 6c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3 3.9M6.2 6.4A17.4 17.4 0 0 0 2 13s3.6 7 10 7a9.6 9.6 0 0 0 4.2-.9" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="m3 3 18 18" />
    </svg>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // The credential check runs server-side now (see ./actions.ts) — the
    // password never touches a client SDK, and the session cookie it sets is
    // httpOnly so client JavaScript cannot read it. Bare usernames are still
    // mapped to the internal email, inside the action.
    const fd = new FormData();
    fd.set("email", email.trim());
    fd.set("password", password);
    const { error } = await signIn(null, fd);
    if (error) {
      setError(error);
      setBusy(false);
      return;
    }
    // Full navigation so the server picks up the fresh session cookie.
    router.replace(next);
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[var(--color-bg)]">
      <div className="w-full max-w-sm bg-surface border border-line rounded-2xl p-7 shadow-[var(--shadow-lg)] rise">
        <div className="text-center mb-6">
          <span
            className="inline-flex h-12 w-12 items-center justify-center rounded-xl text-white font-semibold"
            style={{ background: "var(--color-brand)" }}
          >
            WO
          </span>
          <h1 className="text-lg font-semibold text-ink mt-3">Warehouse Ops</h1>
          <p className="text-muted text-sm">Sign in to continue</p>
        </div>
        <form onSubmit={onSubmit} className="space-y-3">
          {error && (
            <div className="rounded border border-red-200 bg-red-50 text-[var(--color-danger)] px-3 py-2 text-sm">
              {error}
            </div>
          )}
          <label className="block">
            <span className="text-sm text-muted">Username or email</span>
            <input
              type="text"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line px-3 py-2.5 text-sm"
              autoComplete="username"
            />
          </label>
          <label className="block">
            <span className="text-sm text-muted">Password</span>
            <div className="relative mt-1">
              <input
                type={showPassword ? "text" : "password"}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-line pl-3 pr-10 py-2.5 text-sm"
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                title={showPassword ? "Hide password" : "Show password"}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-muted hover:text-ink"
              >
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
          </label>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-[var(--color-brand)] text-white py-2.5 text-sm font-medium shadow-[var(--shadow-sm)] hover:bg-[var(--color-brand-strong)] transition-colors disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

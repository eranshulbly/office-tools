/**
 * Presentational avatar. Given a pre-signed photo URL (resolve it server-side
 * with signedPhotoUrl / signedPhotoUrlMap) shows the face; otherwise a circle
 * with the worker's initials. Purely visual — no data access — so it is safe in
 * any server or client component.
 */
const SIZES = {
  sm: "h-7 w-7 text-[10px]",
  md: "h-10 w-10 text-xs",
  lg: "h-16 w-16 text-base",
  xl: "h-28 w-28 text-2xl",
} as const;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function WorkerAvatar({
  name,
  url,
  size = "md",
}: {
  name: string;
  url?: string | null;
  size?: keyof typeof SIZES;
}) {
  const cls = SIZES[size];
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element -- signed Supabase URL, not optimizable
    return (
      <img
        src={url}
        alt={name}
        loading="lazy"
        decoding="async"
        className={`${cls} rounded-full object-cover border border-line bg-gray-100 shrink-0`}
      />
    );
  }
  return (
    <span
      className={`${cls} rounded-full border border-line bg-gray-100 text-muted font-semibold inline-flex items-center justify-center shrink-0`}
      aria-label={name}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

/** Name + avatar in a row — the common list cell. */
export function WorkerCell({
  name,
  code,
  designation,
  url,
  size = "md",
}: {
  name: string;
  code?: string;
  /** Job title, shown under the name — "Picker Hero", "Supervisor Dispatch". */
  designation?: string | null;
  url?: string | null;
  size?: keyof typeof SIZES;
}) {
  // Code and designation share the sub-line: on a roster of 92 people the title
  // is what tells them apart, and two of them are called Vishal.
  const sub = [code, designation?.trim()].filter(Boolean).join(" · ");
  return (
    <div className="flex items-center gap-2 min-w-0">
      <WorkerAvatar name={name} url={url} size={size} />
      <div className="min-w-0">
        <div className="font-medium text-ink truncate">{name}</div>
        {sub && <div className="text-muted text-xs truncate">{sub}</div>}
      </div>
    </div>
  );
}

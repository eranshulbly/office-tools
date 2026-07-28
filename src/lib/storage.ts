import { createSupabaseServerClient } from "@/lib/supabase/server";

export const PHOTO_BUCKET = "worker-photos";
export const ID_PROOF_BUCKET = "worker-id-proofs";

// Photos: sign for 7 days and REUSE the same URL string for ~6 days. Stable
// URLs mean the browser serves the image from its own cache on repeat views
// instead of re-downloading from Supabase — the key egress saver. Photos are
// staff-viewable, so a shared (per-server-instance) cache is fine.
const PHOTO_SIGN_TTL = 60 * 60 * 24 * 7; // 7 days
const PHOTO_REUSE_MS = 1000 * 60 * 60 * 24 * 6; // reuse a minted URL for 6 days

// ID proofs are sensitive (a signed URL is a bearer token): short TTL, no cache.
const ID_PROOF_TTL = 60 * 30; // 30 minutes

type CachedUrl = { url: string; at: number };
const photoUrlCache = new Map<string, CachedUrl>();

function cachedPhotoUrl(path: string): string | null {
  const hit = photoUrlCache.get(path);
  if (hit && Date.now() - hit.at < PHOTO_REUSE_MS) return hit.url;
  return null;
}

/** One signed URL for a worker photo path, or null. Served from cache when warm. */
export async function signedPhotoUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  const cached = cachedPhotoUrl(path);
  if (cached) return cached;

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrl(path, PHOTO_SIGN_TTL);
  if (data?.signedUrl) {
    photoUrlCache.set(path, { url: data.signedUrl, at: Date.now() });
    return data.signedUrl;
  }
  return null;
}

/**
 * Batch-sign many photo paths at once. Returns a map from path → signed URL.
 * Warm paths come from the cache (0 round-trips); only cold paths are signed,
 * in a single request. Use this for lists/dashboards.
 */
export async function signedPhotoUrlMap(
  paths: Array<string | null | undefined>
): Promise<Record<string, string>> {
  const unique = Array.from(new Set(paths.filter((p): p is string => !!p)));
  if (unique.length === 0) return {};

  const map: Record<string, string> = {};
  const cold: string[] = [];
  for (const p of unique) {
    const c = cachedPhotoUrl(p);
    if (c) map[p] = c;
    else cold.push(p);
  }

  if (cold.length > 0) {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(cold, PHOTO_SIGN_TTL);
    for (const item of data ?? []) {
      if (item.signedUrl && item.path) {
        map[item.path] = item.signedUrl;
        photoUrlCache.set(item.path, { url: item.signedUrl, at: Date.now() });
      }
    }
  }
  return map;
}

/** Signed URL for an identity proof — admin only (RLS enforces). Not cached. */
export async function signedIdProofUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.storage.from(ID_PROOF_BUCKET).createSignedUrl(path, ID_PROOF_TTL);
  return data?.signedUrl ?? null;
}

function extOf(filename: string): string {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "bin";
}

/**
 * Upload a worker file (photo or id proof) to its bucket and return the stored
 * path. Uses the authenticated server client, so storage RLS applies (admin
 * only for writes). Returns null if no file was provided.
 */
export async function uploadWorkerFile(
  bucket: typeof PHOTO_BUCKET | typeof ID_PROOF_BUCKET,
  workerId: string,
  file: File | null,
  kind: "photo" | "idproof"
): Promise<{ path: string } | { error: string } | null> {
  if (!file || file.size === 0) return null;
  const supabase = await createSupabaseServerClient();
  const path = `${workerId}/${kind}-${Date.now()}.${extOf(file.name)}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error } = await supabase.storage.from(bucket).upload(path, bytes, {
    contentType: file.type || "application/octet-stream",
    // Long cache: the path is unique per upload (timestamped), so a replacement
    // is a new path and never a stale cache. Photos are immutable once written.
    cacheControl: `${60 * 60 * 24 * 30}`, // 30 days
    upsert: true,
  });
  if (error) return { error: error.message };
  return { path };
}

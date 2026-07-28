import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — bypasses RLS. SERVER-ONLY. Use exclusively in
 * server actions that must do privileged things the logged-in user can't do via
 * RLS, e.g. creating manager auth accounts. NEVER import this into a client
 * component. Always gate the calling action with an admin role check first.
 */
export function createSupabaseAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

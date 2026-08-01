import { cookies } from "next/headers";
import { Query, type Result, type Row } from "./builder";
import { readToken, sessionCookie } from "./session";
import { callRpc, isRpcImplemented } from "./rpc";
import { check, opFor, type Role } from "./authz";
import { query } from "./pool";

/**
 * Drop-in replacement for the Supabase server client, backed by MySQL.
 *
 * Shape matches what the app already calls:
 *   db.from("cheques").select("*").eq("status", "draft")
 *   db.rpc("submit_cheque", { p_id: id })
 *   db.auth.getUser()   ->  { data: { user } }
 *
 * Keeping this signature means the 121 existing call sites compile and run
 * unchanged — the migration risk sits in this module and the builder, both of
 * which can be tested directly, rather than being spread across 52 files.
 */

export type DbUser = { id: string; email?: string };

export class DbClient {
  private userId: string | null;
  /** Role is looked up once per client (i.e. once per request), then reused. */
  private rolePromise: Promise<Role | null> | null = null;
  private enforce: boolean;

  constructor(userId: string | null, opts?: { enforce?: boolean }) {
    this.userId = userId;
    this.enforce = opts?.enforce ?? true;
  }

  private async role(): Promise<Role | null> {
    if (!this.userId) return null;
    this.rolePromise ??= query<{ role: Role }>(
      "SELECT role FROM profiles WHERE id = ? LIMIT 1",
      [this.userId]
    ).then((r) => r[0]?.role ?? null);
    return this.rolePromise;
  }

  // Defaults to `any`, matching the untyped Supabase client the call sites were
  // written against. Defaulting to Row here would type every result as a single
  // object and break the many sites that iterate arrays.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from<T = any>(table: string): Query<T> {
    if (!this.enforce) return new Query<T>(table);
    return new Query<T>(table, async (t, op) => {
      const denial = check(await this.role(), t, opFor(op));
      return denial ? `permission denied for ${denial.table}: ${denial.reason}` : null;
    });
  }

  /**
   * Postgres RPCs are being ported one at a time. An unported name throws
   * loudly rather than returning an empty result — a silent no-op in payroll
   * or cheque code would be far worse than a visible failure.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async rpc<T = any>(name: string, args: Row = {}): Promise<Result<T>> {
    if (!isRpcImplemented(name)) {
      return {
        data: null,
        error: {
          message: `RPC "${name}" has not been ported to MySQL yet.`,
          code: "RPC_NOT_PORTED",
        },
        count: null,
      };
    }
    try {
      const data = (await callRpc(name, args, this.userId)) as T;
      return { data, error: null, count: null };
    } catch (e) {
      return {
        data: null,
        error: { message: e instanceof Error ? e.message : String(e) },
        count: null,
      };
    }
  }

  get auth() {
    const uid = this.userId;
    return {
      async getUser(): Promise<{ data: { user: DbUser | null }; error: null }> {
        return { data: { user: uid ? { id: uid } : null }, error: null };
      },
      async signOut(): Promise<{ error: null }> {
        const jar = await cookies();
        jar.set(sessionCookie.name, "", { ...sessionCookie.options, maxAge: 0 });
        return { error: null };
      },
    };
  }

  /**
   * Storage moved to S3. Supabase Storage held ZERO objects at migration time
   * (no worker photos, no id proofs were ever uploaded), so nothing had to be
   * copied — but the four call sites still need a shape to talk to.
   */
  get storage() {
    return {
      from(bucket: string) {
        void bucket;
        const notWired = { message: "Storage is not yet wired to S3" };
        return {
          // Signatures match @supabase/storage-js so the four call sites in
          // src/lib/storage.ts compile unchanged until S3 is wired in.
          async createSignedUrl(
            path: string,
            expiresIn: number
          ): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }> {
            void path;
            void expiresIn;
            return { data: null, error: notWired };
          },
          async createSignedUrls(
            paths: string[],
            expiresIn: number
          ): Promise<{
            data: { path: string | null; signedUrl: string; error: string | null }[] | null;
            error: { message: string } | null;
          }> {
            void paths;
            void expiresIn;
            return { data: null, error: notWired };
          },
          async upload(
            path: string,
            file: unknown,
            opts?: Record<string, unknown>
          ): Promise<{ data: { path: string } | null; error: { message: string } | null }> {
            void path;
            void file;
            void opts;
            return { data: null, error: notWired };
          },
          async remove(
            paths: string[]
          ): Promise<{ data: unknown[] | null; error: { message: string } | null }> {
            void paths;
            return { data: null, error: notWired };
          },
        };
      },
    };
  }
}

/** Request-scoped client. Reads the session cookie to identify the caller. */
export async function createDbClient(): Promise<DbClient> {
  const jar = await cookies();
  const userId = readToken(jar.get(sessionCookie.name)?.value);
  return new DbClient(userId);
}

/**
 * Service client — no user bound and authorization NOT enforced. This is the
 * equivalent of the old service-role key, which bypassed RLS: used for
 * creating manager accounts and reading auth users. Server-only; never
 * construct this anywhere a browser request can reach it directly.
 */
export function createDbServiceClient(): DbClient {
  return new DbClient(null, { enforce: false });
}

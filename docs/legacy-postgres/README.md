# Legacy Postgres migrations (historical reference — NOT applied)

These are the original Supabase/Postgres migrations. **Nothing runs them any
more.** The app moved to MySQL on RDS; the live schema is created by the
handwritten MySQL DDL, and there is no migration runner (`db-push.ts` was
removed — it used the `pg` driver against what is now a MySQL `DATABASE_URL`).

They are kept because they are the **only record of the logic that was ported**:

- `0003_functions.sql` and later files contain the 43 PL/pgSQL functions the
  TypeScript RPCs in `src/lib/db/rpc.ts` were translated from — including
  `recompute_attendance`, `compute_payroll_run` and `approve_payroll_run`.
  If a ported function is ever suspected of drifting, this is what to diff
  against.
- `0002_rls.sql` holds the 39 row-level-security policies now reimplemented in
  `src/lib/db/authz.ts`.

Do not apply them. Do not treat them as current. Read them to answer "what did
the original do?", nothing else.

## What replaced what

| Postgres (here) | MySQL (live) |
|---|---|
| RLS policies (`0002_rls.sql`) | `src/lib/db/authz.ts` — enforced centrally in the query builder |
| SECURITY DEFINER functions | `src/lib/db/rpc.ts` — TypeScript, transactional |
| `auth.users` (Supabase Auth) | `auth_users` table + `src/lib/db/session.ts` |
| Storage buckets | not yet migrated — S3 pending, zero objects existed |

## Outstanding

`tests/payroll.spec.ts` and `tests/recompute.spec.ts` still target Postgres and
**cannot run**. They encode the 12 payroll acceptance cases from spec §3.4 and
remain the specification of correct payroll behaviour — port them to MySQL and
get them passing before running real payroll.

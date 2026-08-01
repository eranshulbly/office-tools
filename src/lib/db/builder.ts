import { pool } from "./pool";
import type { RowDataPacket, ResultSetHeader } from "mysql2";

/**
 * A PostgREST-shaped query builder over MySQL.
 *
 * Why this exists: the app has 121 `.from(...)` call sites written against the
 * Supabase client. Rewriting each one into raw SQL would be 121 chances to drop
 * a filter on a payroll table. Instead this reproduces the slice of the
 * Supabase surface the app actually uses, so those call sites keep working
 * untouched and the risk collapses into one module that can be tested directly.
 *
 * Supported (everything the codebase uses):
 *   from · select · insert · update · upsert · delete
 *   eq · neq · gt · gte · lt · lte · in · is · not · like · ilike · match · contains
 *   order · limit · range · single · maybeSingle
 *   select(cols, { count: "exact", head: true })
 *
 * Deliberately NOT supported: embedded/nested resource selects
 * (`select("*, workers(full_name)")`). Those appear only in the workers,
 * attendance, payroll and disburse modules, all of which hold zero rows. The
 * builder throws a clear error rather than silently returning wrong shapes —
 * see `parseSelect`.
 *
 * ── SECURITY ──────────────────────────────────────────────────────────────
 * This layer does NOT enforce row-level security. Postgres RLS was the real
 * authorization boundary (39 policies); the app's route guards were, in the
 * README's words, "cosmetic". Authorization now has to be explicit in the data
 * access layer above this. Do not treat a query passing through here as
 * authorised.
 */

export type PgError = { message: string; code?: string } | null;
export type Row = Record<string, unknown>;

/**
 * `data` mirrors PostgREST's typing: an ARRAY for normal selects, and a single
 * object only after .single()/.maybeSingle(). That distinction is not cosmetic
 * — call sites do `(res.data ?? []).map(...)`, which only compiles if the type
 * carries array-ness. The element type stays `any`, exactly as the untyped
 * Supabase client was, so no call site needs editing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Result<D = any> = { data: D | null; error: PgError; count: number | null };

/** Whether the query yields a list or a single row. Set by .single(). */
type Mode = "many" | "one";
type Data<T, M extends Mode> = M extends "one" ? T : T[];

type Filter = { sql: string; params: unknown[] };
type Op = "select" | "insert" | "update" | "upsert" | "delete";

/**
 * Called before every statement runs. Returns a reason string to refuse, or
 * null to allow. This is where RLS lives now — see authz.ts.
 */
export type Guard = (table: string, op: Op) => Promise<string | null>;

/** Backtick-quote an identifier, rejecting anything that isn't a plain name. */
function ident(name: string): string {
  const n = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return `\`${n}\``;
}

/**
 * Foreign keys behind PostgREST's embedded-resource syntax.
 *
 * Supabase resolved `select("*, workers(full_name)")` from the FK graph. MySQL
 * has the same constraints but no such query layer, so the three relations the
 * app actually embeds are declared here. Anything else raises rather than
 * quietly returning rows without the nested object.
 */
const RELATIONS: Record<string, { fk: string; pk: string }> = {
  workers: { fk: "worker_id", pk: "id" },
  worker_groups: { fk: "group_id", pk: "id" },
  payroll_runs: { fk: "run_id", pk: "id" },
};

type Embed = { key: string; table: string; cols: string; fk: string; pk: string };

/**
 * Split a select list into scalar columns and embedded resources.
 * Handles `table(a,b)`, `alias:table(a,b)` and `alias:column`.
 */
function parseSelect(cols: string): { sql: string; embeds: Embed[] } {
  const c = cols.trim();
  if (c === "" || c === "*") return { sql: "*", embeds: [] };

  // Split on top-level commas only — commas inside rel(...) belong to the rel.
  const parts: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of c) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(buf); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);

  const scalars: string[] = [];
  const embeds: Embed[] = [];

  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;

    const rel = part.match(/^(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)$/s);
    if (rel) {
      const [, alias, table, inner] = rel;
      const def = RELATIONS[table];
      if (!def) throw new Error(`No relation mapping for embedded resource "${table}"`);
      embeds.push({ key: alias || table, table, cols: inner, fk: def.fk, pk: def.pk });
      continue;
    }

    const aliased = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)$/);
    if (aliased) { scalars.push(`${ident(aliased[2])} AS ${ident(aliased[1])}`); continue; }
    scalars.push(ident(part));
  }

  // The FK must be selected so rows can be matched to their parent, even when
  // the caller didn't ask for it. Stripped again after attaching.
  for (const e of embeds) {
    if (!scalars.some((s) => s.includes(`\`${e.fk}\``))) scalars.push(ident(e.fk));
  }
  return { sql: scalars.length ? scalars.join(", ") : "*", embeds };
}

export class Query<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T = any,
  M extends Mode = "many",
> implements PromiseLike<Result<Data<T, M>>> {
  private table: string;
  private op: Op = "select";
  private cols = "*";
  private filters: Filter[] = [];
  private orders: string[] = [];
  private limitN: number | null = null;
  private offsetN: number | null = null;
  private payload: Row[] = [];
  private wantCount = false;
  private headOnly = false;
  private rowMode: "many" | "one" | "maybeOne" = "many";
  private upsertKeys: string[] = [];
  private embeds: Embed[] = [];
  private guard?: Guard;

  constructor(table: string, guard?: Guard) {
    this.table = table;
    this.guard = guard;
  }

  // ── projection / mutation ──────────────────────────────────────────────
  select(cols = "*", opts?: { count?: "exact" | "planned"; head?: boolean }): this {
    if (this.op === "select") {
      const parsed = parseSelect(cols);
      this.cols = parsed.sql;
      this.embeds = parsed.embeds;
    }
    if (opts?.count) this.wantCount = true;
    if (opts?.head) this.headOnly = true;
    return this;
  }

  insert(values: Row | Row[]): this {
    this.op = "insert";
    this.payload = Array.isArray(values) ? values : [values];
    return this;
  }

  update(values: Row): this {
    this.op = "update";
    this.payload = [values];
    return this;
  }

  upsert(values: Row | Row[], opts?: { onConflict?: string }): this {
    this.op = "upsert";
    this.payload = Array.isArray(values) ? values : [values];
    this.upsertKeys = opts?.onConflict ? opts.onConflict.split(",").map((s) => s.trim()) : [];
    return this;
  }

  delete(): this {
    this.op = "delete";
    return this;
  }

  // ── filters ────────────────────────────────────────────────────────────
  private push(sql: string, params: unknown[] = []): this {
    this.filters.push({ sql, params });
    return this;
  }

  eq(col: string, val: unknown): this {
    return val === null
      ? this.push(`${ident(col)} IS NULL`)
      : this.push(`${ident(col)} = ?`, [val]);
  }
  neq(col: string, val: unknown): this {
    return this.push(`${ident(col)} <> ?`, [val]);
  }
  gt(col: string, val: unknown): this { return this.push(`${ident(col)} > ?`, [val]); }
  gte(col: string, val: unknown): this { return this.push(`${ident(col)} >= ?`, [val]); }
  lt(col: string, val: unknown): this { return this.push(`${ident(col)} < ?`, [val]); }
  lte(col: string, val: unknown): this { return this.push(`${ident(col)} <= ?`, [val]); }

  in(col: string, vals: readonly unknown[]): this {
    // An empty IN () is a syntax error in MySQL and, semantically, matches
    // nothing — so emit a false predicate rather than a broken statement.
    if (!vals.length) return this.push("1 = 0");
    return this.push(`${ident(col)} IN (${vals.map(() => "?").join(",")})`, [...vals]);
  }

  is(col: string, val: null | boolean): this {
    if (val === null) return this.push(`${ident(col)} IS NULL`);
    return this.push(`${ident(col)} = ?`, [val ? 1 : 0]);
  }

  like(col: string, pattern: string): this { return this.push(`${ident(col)} LIKE ?`, [pattern]); }
  /** MySQL's default collation is already case-insensitive, so ilike == like. */
  ilike(col: string, pattern: string): this { return this.like(col, pattern); }

  contains(col: string, val: unknown): this {
    return this.push(`JSON_CONTAINS(${ident(col)}, ?)`, [JSON.stringify(val)]);
  }

  not(col: string, op: string, val: unknown): this {
    if (op === "is" && val === null) return this.push(`${ident(col)} IS NOT NULL`);
    if (op === "in" && Array.isArray(val)) {
      if (!val.length) return this;
      return this.push(`${ident(col)} NOT IN (${val.map(() => "?").join(",")})`, [...val]);
    }
    const cmp: Record<string, string> = { eq: "<>", gt: "<=", gte: "<", lt: ">=", lte: ">" };
    return this.push(`${ident(col)} ${cmp[op] ?? "<>"} ?`, [val]);
  }

  match(obj: Row): this {
    for (const [k, v] of Object.entries(obj)) this.eq(k, v);
    return this;
  }

  // ── shaping ────────────────────────────────────────────────────────────
  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    const dir = opts?.ascending === false ? "DESC" : "ASC";
    this.orders.push(`${ident(col)} ${dir}`);
    return this;
  }
  limit(n: number): this { this.limitN = n; return this; }
  range(from: number, to: number): this {
    this.offsetN = from;
    this.limitN = to - from + 1;
    return this;
  }
  // Both narrow the result from a list to one row, which the type must follow.
  single(): Query<T, "one"> {
    this.rowMode = "one";
    this.limitN ??= 2;
    return this as unknown as Query<T, "one">;
  }
  maybeSingle(): Query<T, "one"> {
    this.rowMode = "maybeOne";
    this.limitN ??= 2;
    return this as unknown as Query<T, "one">;
  }

  // ── execution ──────────────────────────────────────────────────────────
  private where(): { sql: string; params: unknown[] } {
    if (!this.filters.length) return { sql: "", params: [] };
    return {
      sql: " WHERE " + this.filters.map((f) => f.sql).join(" AND "),
      params: this.filters.flatMap((f) => f.params),
    };
  }

  private async run(): Promise<Result<Data<T, M>>> {
    // Authorization first, before any SQL is built or sent. Postgres applied
    // RLS to every statement automatically; this is the equivalent choke point.
    if (this.guard) {
      const denied = await this.guard(this.table, this.op);
      if (denied) {
        return { data: null, error: { message: denied, code: "42501" }, count: null };
      }
    }

    const t = ident(this.table);
    const w = this.where();

    if (this.op === "select") {
      let count: number | null = null;
      if (this.wantCount) {
        const [c] = (await pool.query(
          `SELECT COUNT(*) AS n FROM ${t}${w.sql}`,
          w.params
        )) as [RowDataPacket[], unknown];
        count = Number(c[0]?.n ?? 0);
      }
      if (this.headOnly) return { data: null, error: null, count };

      let sql = `SELECT ${this.cols} FROM ${t}${w.sql}`;
      if (this.orders.length) sql += ` ORDER BY ${this.orders.join(", ")}`;
      if (this.limitN != null) sql += ` LIMIT ${Number(this.limitN)}`;
      if (this.offsetN != null) sql += ` OFFSET ${Number(this.offsetN)}`;

      const [rows] = (await pool.query(sql, w.params)) as [RowDataPacket[], unknown];
      const withEmbeds = await this.attachEmbeds(rows as Row[]);
      return this.shape(withEmbeds, count);
    }

    if (this.op === "insert" || this.op === "upsert") {
      if (!this.payload.length) return { data: null, error: null, count: null };
      const cols = Object.keys(this.payload[0]);
      const colSql = cols.map(ident).join(", ");
      const placeholders = this.payload.map(() => `(${cols.map(() => "?").join(",")})`).join(", ");
      const params = this.payload.flatMap((r) => cols.map((c) => normalise(r[c])));

      let sql = `INSERT INTO ${t} (${colSql}) VALUES ${placeholders}`;
      if (this.op === "upsert") {
        // MySQL has no ON CONFLICT (cols); ON DUPLICATE KEY fires for whichever
        // unique key collides, which matches how the app uses upsert here.
        const updatable = cols.filter((c) => !this.upsertKeys.includes(c));
        const setList = (updatable.length ? updatable : cols)
          .map((c) => `${ident(c)} = VALUES(${ident(c)})`)
          .join(", ");
        sql += ` ON DUPLICATE KEY UPDATE ${setList}`;
      }
      await pool.query(sql, params);
      return this.returning(cols);
    }

    if (this.op === "update") {
      const entries = Object.entries(this.payload[0] ?? {});
      if (!entries.length) return { data: null, error: null, count: null };
      const setSql = entries.map(([k]) => `${ident(k)} = ?`).join(", ");
      const setParams = entries.map(([, v]) => normalise(v));
      const [res] = (await pool.query(
        `UPDATE ${t} SET ${setSql}${w.sql}`,
        [...setParams, ...w.params]
      )) as [ResultSetHeader, unknown];
      return { data: null, error: null, count: res.affectedRows };
    }

    // delete
    const [res] = (await pool.query(`DELETE FROM ${t}${w.sql}`, w.params)) as [
      ResultSetHeader,
      unknown,
    ];
    return { data: null, error: null, count: res.affectedRows };
  }

  /**
   * Supabase returns inserted rows when .select() is chained. MySQL gives no
   * RETURNING, so re-read by the natural key when the caller asked for it.
   */
  private async returning(cols: string[]): Promise<Result<Data<T, M>>> {
    if (this.cols === "*" && this.rowMode === "many" && !this.wantCount) {
      return { data: null, error: null, count: this.payload.length };
    }
    const first = this.payload[0];
    if (first && "id" in first && first.id != null) {
      const [rows] = (await pool.query(
        `SELECT ${this.cols} FROM ${ident(this.table)} WHERE \`id\` = ?`,
        [first.id]
      )) as [RowDataPacket[], unknown];
      return this.shape(rows as Row[], null);
    }
    void cols;
    return { data: null, error: null, count: this.payload.length };
  }

  /**
   * Resolve embedded resources with one extra query per relation, then attach
   * the nested object under its key — matching what PostgREST returned.
   *
   * One query per relation, not per row: a naive implementation here would fire
   * N+1 queries against a shared db.t4g.micro and exhaust its ~85 connections.
   */
  private async attachEmbeds(rows: Row[]): Promise<Row[]> {
    if (!this.embeds.length || !rows.length) return rows;

    for (const e of this.embeds) {
      const ids = [...new Set(rows.map((r) => r[e.fk]).filter((v) => v != null))];
      if (!ids.length) {
        for (const r of rows) r[e.key] = null;
        continue;
      }
      const inner = parseSelect(e.cols);
      // The join key must come back so rows can be indexed by it.
      const cols =
        inner.sql === "*" || inner.sql.includes(`\`${e.pk}\``)
          ? inner.sql
          : `${inner.sql}, ${ident(e.pk)}`;

      const [related] = (await pool.query(
        `SELECT ${cols} FROM ${ident(e.table)} WHERE ${ident(e.pk)} IN (${ids.map(() => "?").join(",")})`,
        ids
      )) as [RowDataPacket[], unknown];

      const byId = new Map((related as Row[]).map((r) => [String(r[e.pk]), r]));
      for (const r of rows) {
        const k = r[e.fk];
        r[e.key] = k == null ? null : (byId.get(String(k)) ?? null);
      }
    }
    return rows;
  }

  private shape(rows: Row[], count: number | null): Result<Data<T, M>> {
    if (this.rowMode === "one") {
      if (rows.length !== 1) {
        return {
          data: null,
          error: {
            message:
              rows.length === 0
                ? "JSON object requested, multiple (or no) rows returned"
                : "more than one row returned by a query expecting a single row",
            code: rows.length === 0 ? "PGRST116" : "PGRST114",
          },
          count,
        };
      }
      return { data: rows[0] as Data<T, M>, error: null, count };
    }
    if (this.rowMode === "maybeOne") {
      return { data: (rows[0] ?? null) as Data<T, M>, error: null, count };
    }
    return { data: rows as Data<T, M>, error: null, count };
  }

  /**
   * Signature mirrors lib.es5's PromiseLike.then exactly — including the
   * `undefined` in the parameter unions and the `Promise` return. Anything
   * looser and TypeScript fails to resolve `Awaited<Query>` inside
   * `Promise.all`, which silently degrades every parallel query in the app to
   * `unknown`.
   */
  then<R1 = Result<Data<T, M>>, R2 = never>(
    onOk?: ((v: Result<Data<T, M>>) => R1 | PromiseLike<R1>) | undefined | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onErr?: ((r: any) => R2 | PromiseLike<R2>) | undefined | null
  ): Promise<R1 | R2> {
    return this.run()
      .catch((e: unknown): Result<Data<T, M>> => ({
        data: null,
        error: { message: e instanceof Error ? e.message : String(e) },
        count: null,
      }))
      .then(onOk, onErr);
  }
}

/** Booleans and objects need coercing to what MySQL columns expect. */
function normalise(v: unknown): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v !== null && typeof v === "object" && !(v instanceof Date)) return JSON.stringify(v);
  return v;
}

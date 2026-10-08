/**
 * ユニットテスト用の、スキーマを検査する簡易 PostgREST (supabase-js のクエリビルダー) の再現。
 *
 * fake-supabase.ts は「テーブルごとに用意した結果をそのまま返す」だけで、コードが付けた絞り込みも、
 * 存在しない列・外部キーも見ない。そのため次のような不具合がモックのテストをすり抜ける:
 *   - 絞り込みの付け忘れで他人の行まで数えてしまう (サポート画面の mealCount: #1161)
 *   - 存在しない列への書き込み・絞り込み (admin_audit_logs.admin_id: 実際の列は actor_id)
 *   - 外部キーが無い関係の埋め込み (admin_user_notes.admin_id → auth.users なので user_profiles は埋め込めない)
 *
 * こちらは行の配列を持ち、コードが付けた絞り込み (.eq / .in / .gte / .not) を実際に適用し、
 * 列と外部キーはリポジトリ内のスキーマ (supabase/baseline + 新しい migration。schema-snapshot.ts) で検査して、
 * 本物の PostgREST と同じコードのエラー (42703 / PGRST200 / PGRST204 / PGRST205 / PGRST116) を返す。
 * DB には接続しない。
 *
 * 再現する範囲 (テストが使う部分だけ):
 *   - select(columns, { count: 'exact', head: true })  列 / 'rel(cols)' / 'rel!inner(cols)' / 'alias:rel(cols)' の埋め込み
 *   - insert / update / delete (+ .select() で返す列)
 *   - eq / in / gte / not(col, 'is', null) / order / limit。'rel.col' 形式の埋め込み先の絞り込みを含む
 *   - single() / maybeSingle()
 * 埋め込みは「このテーブルが外部キーで親を指す」向き (to-one) だけ。親から子 (to-many) は未対応。
 * 外部キーの参照先の列は常に id とみなす。RLS は再現しない (RLS で見える行だけを tables に入れて再現する)。
 */
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { loadSchemaModel, type SchemaTable } from './schema-snapshot';

export type Row = Record<string, any>;

export interface DbError {
  message: string;
  code?: string;
}

export interface SchemaDbOptions {
  /** テーブル名 -> 初期の行 */
  tables?: Record<string, Row[]>;
  /** テーブル名 -> そのテーブルへの全ての操作が返すエラー (DB 障害の再現) */
  errors?: Record<string, DbError>;
}

export interface RecordedQuery {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  /** select の列指定 (insert / update / delete の後ろに付けた .select() も含む)。無ければ null */
  select: string | null;
  count: boolean;
  head: boolean;
  eq: Array<[string, unknown]>;
  in: Array<[string, unknown[]]>;
  gte: Array<[string, unknown]>;
  /** insert / update に渡した値 */
  values: unknown;
}

let schemaCache: Map<string, SchemaTable> | null = null;
function schema(): Map<string, SchemaTable> {
  schemaCache ??= loadSchemaModel();
  return schemaCache;
}

const error = (code: string, message: string): DbError & { details: null; hint: null } => ({
  code,
  message,
  details: null,
  hint: null,
});

/** 括弧の外にあるカンマで分割する */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

interface Embed {
  alias: string;
  relation: string;
  inner: boolean;
  columns: string;
}

/** 'alias:table!hint!inner(cols)' を分解する。埋め込みでなければ null */
function parseEmbed(part: string): Embed | null {
  if (!part.includes('(')) return null;
  const m = part.match(/^(?:([a-z_0-9]+):)?([a-z_0-9]+)((?:![a-z_0-9]+)*)\((.*)\)$/);
  if (!m) throw new Error(`schema-checked-db: cannot parse embed "${part}"`);
  const [, alias, relation, hints, columns] = m;
  return { alias: alias ?? relation, relation, inner: hints.split('!').includes('inner'), columns };
}

class PostgrestFailure extends Error {
  constructor(public readonly body: DbError) {
    super(body.message);
  }
}

interface Filter {
  kind: 'eq' | 'in' | 'gte' | 'not-null';
  column: string;
  value: unknown;
}

export function createSchemaDb(options: SchemaDbOptions = {}) {
  const tables: Record<string, Row[]> = structuredClone(options.tables ?? {});
  const queries: RecordedQuery[] = [];

  const tableSchema = (table: string): SchemaTable => {
    const t = schema().get(table);
    if (!t) throw new PostgrestFailure(error('PGRST205', `Could not find the table 'public.${table}' in the schema cache`));
    return t;
  };

  const assertColumn = (table: string, column: string) => {
    if (!tableSchema(table).columns.includes(column)) {
      throw new PostgrestFailure(error('42703', `column ${table}.${column} does not exist`));
    }
  };

  /** このテーブルから relation (親テーブル) への外部キー列。無ければ PostgREST と同じ PGRST200 */
  const foreignKeyTo = (table: string, relation: string): string => {
    const fk = tableSchema(table).foreignKeys.find((f) => f.refSchema === 'public' && f.refTable === relation);
    if (!fk) {
      throw new PostgrestFailure(
        error('PGRST200', `Could not find a relationship between '${table}' and '${relation}' in the schema cache`),
      );
    }
    return fk.column;
  };

  const parentOf = (table: string, relation: string, row: Row): Row | null => {
    const fk = foreignKeyTo(table, relation);
    return (tables[relation] ?? []).find((p) => p.id === row[fk]) ?? null;
  };

  /**
   * select の列指定を、行が 1 件も無くても検査する (PostgREST は行を読む前に、列と関係を解決するため)。
   * 存在しない列は 42703、外部キーの無い埋め込みは PGRST200 になる。
   */
  function validateSelect(table: string, columns: string) {
    for (const part of splitTopLevel(columns)) {
      const embed = parseEmbed(part);
      if (embed) {
        foreignKeyTo(table, embed.relation);
        validateSelect(embed.relation, embed.columns);
      } else if (part !== '*') {
        assertColumn(table, part);
      }
    }
  }

  function project(table: string, row: Row, columns: string): Row {
    const out: Row = {};
    for (const part of splitTopLevel(columns)) {
      const embed = parseEmbed(part);
      if (embed) {
        const parent = parentOf(table, embed.relation, row);
        out[embed.alias] = parent ? project(embed.relation, parent, embed.columns) : null;
      } else if (part === '*') {
        Object.assign(out, row);
      } else {
        out[part] = row[part];
      }
    }
    return structuredClone(out);
  }

  class Query implements PromiseLike<unknown> {
    private op: RecordedQuery['op'] = 'select';
    private rec: RecordedQuery;
    private filters: Filter[] = [];
    private orders: Array<{ column: string; ascending: boolean }> = [];
    private limitTo: number | null = null;
    private values: Row[] = [];
    private cardinality: 'many' | 'single' | 'maybe' = 'many';

    constructor(private readonly table: string) {
      this.rec = { table, op: 'select', select: null, count: false, head: false, eq: [], in: [], gte: [], values: undefined };
      queries.push(this.rec);
    }

    select(columns = '*', opts?: { count?: string; head?: boolean }) {
      this.rec.select = columns;
      this.rec.count = opts?.count === 'exact';
      this.rec.head = opts?.head === true;
      return this;
    }
    insert(values: Row | Row[]) {
      this.op = this.rec.op = 'insert';
      this.rec.values = values;
      this.values = Array.isArray(values) ? values : [values];
      return this;
    }
    update(values: Row) {
      this.op = this.rec.op = 'update';
      this.rec.values = values;
      this.values = [values];
      return this;
    }
    delete() {
      this.op = this.rec.op = 'delete';
      return this;
    }
    eq(column: string, value: unknown) {
      this.rec.eq.push([column, value]);
      this.filters.push({ kind: 'eq', column, value });
      return this;
    }
    in(column: string, value: unknown[]) {
      this.rec.in.push([column, value]);
      this.filters.push({ kind: 'in', column, value });
      return this;
    }
    gte(column: string, value: unknown) {
      this.rec.gte.push([column, value]);
      this.filters.push({ kind: 'gte', column, value });
      return this;
    }
    not(column: string, operator: string, value: unknown) {
      if (operator !== 'is' || value !== null) throw new Error('schema-checked-db: only .not(col, "is", null) is supported');
      this.filters.push({ kind: 'not-null', column, value: null });
      return this;
    }
    order(column: string, opts?: { ascending?: boolean }) {
      this.orders.push({ column, ascending: opts?.ascending !== false });
      return this;
    }
    limit(count: number) {
      this.limitTo = count;
      return this;
    }
    single() {
      this.cardinality = 'single';
      return this.run();
    }
    maybeSingle() {
      this.cardinality = 'maybe';
      return this.run();
    }
    then<T1 = unknown, T2 = never>(
      onfulfilled?: ((value: unknown) => T1 | PromiseLike<T1>) | null,
      onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
    ): PromiseLike<T1 | T2> {
      return this.run().then(onfulfilled, onrejected);
    }

    private async run(): Promise<{ data: unknown; error: unknown; count: number | null }> {
      try {
        const configured = options.errors?.[this.table];
        if (configured) throw new PostgrestFailure({ ...configured });
        return this.execute();
      } catch (e) {
        if (e instanceof PostgrestFailure) return { data: null, error: e.body, count: null };
        throw e;
      }
    }

    /** 埋め込みのうち、'rel.col' 形式の絞り込みの対象になっているものを返す */
    private embeds(): Map<string, Embed> {
      const map = new Map<string, Embed>();
      for (const part of splitTopLevel(this.rec.select ?? '')) {
        const embed = parseEmbed(part);
        if (embed) map.set(embed.alias, embed);
      }
      return map;
    }

    /** 絞り込みの列を、行が 1 件も無くても検査する ('rel.col' は、select で埋め込んでいる関係だけに使える) */
    private validateFilters(embeds: Map<string, Embed>) {
      for (const f of this.filters) {
        if (!f.column.includes('.')) {
          assertColumn(this.table, f.column);
          continue;
        }
        const [alias, embeddedColumn] = f.column.split('.');
        const embed = embeds.get(alias);
        if (!embed) {
          throw new PostgrestFailure(error('PGRST108', `'${alias}' is not an embedded resource in this request`));
        }
        assertColumn(embed.relation, embeddedColumn);
      }
      for (const { column } of this.orders) assertColumn(this.table, column);
    }

    private matches(row: Row, embeds: Map<string, Embed>): boolean {
      return this.filters.every((f) => {
        let target = row;
        let column = f.column;
        if (column.includes('.')) {
          const [alias, embeddedColumn] = column.split('.');
          const embed = embeds.get(alias)!;
          // 内部結合でない埋め込みは、絞り込みに合わなくても行を残す (埋め込みだけが null になる)
          if (!embed.inner) return true;
          const parent = parentOf(this.table, embed.relation, row);
          if (!parent) return false;
          target = parent;
          column = embeddedColumn;
        }
        const actual = target[column];
        switch (f.kind) {
          case 'eq':
            return actual === f.value;
          case 'in':
            return (f.value as unknown[]).includes(actual);
          case 'gte':
            return actual !== null && actual !== undefined && (actual as string | number) >= (f.value as string | number);
          case 'not-null':
            return actual !== null && actual !== undefined;
        }
      });
    }

    private execute(): { data: unknown; error: unknown; count: number | null } {
      tableSchema(this.table);
      const source = (tables[this.table] ??= []);
      const embeds = this.embeds();
      validateSelect(this.table, this.rec.select ?? '*');
      this.validateFilters(embeds);

      // 内部結合 (!inner) の埋め込みは、親が無い行を結果から外す
      const hasParents = (row: Row) =>
        [...embeds.values()].every((e) => !e.inner || parentOf(this.table, e.relation, row) !== null);

      let affected: Row[];
      if (this.op === 'insert') {
        const now = new Date().toISOString();
        const inserted = this.values.map((v) => {
          for (const column of Object.keys(v)) {
            if (!tableSchema(this.table).columns.includes(column)) {
              throw new PostgrestFailure(
                error('PGRST204', `Could not find the '${column}' column of '${this.table}' in the schema cache`),
              );
            }
          }
          const row: Row = { ...structuredClone(v) };
          const columns = tableSchema(this.table).columns;
          if (columns.includes('id') && row.id === undefined) row.id = randomUUID();
          if (columns.includes('created_at') && row.created_at === undefined) row.created_at = now;
          return row;
        });
        source.push(...inserted);
        affected = inserted;
      } else {
        const matched = source.filter((row) => this.matches(row, embeds) && hasParents(row));
        if (this.op === 'update') {
          for (const column of Object.keys(this.values[0])) {
            if (!tableSchema(this.table).columns.includes(column)) {
              throw new PostgrestFailure(
                error('PGRST204', `Could not find the '${column}' column of '${this.table}' in the schema cache`),
              );
            }
          }
          matched.forEach((row) => Object.assign(row, structuredClone(this.values[0])));
        } else if (this.op === 'delete') {
          tables[this.table] = source.filter((row) => !matched.includes(row));
        }
        affected = matched;
      }

      // select 以外で .select() を付けていなければ、行は返さない
      if (this.op !== 'select' && this.rec.select === null) {
        return { data: null, error: null, count: null };
      }

      let rows = [...affected];
      for (const { column, ascending } of [...this.orders].reverse()) {
        rows.sort((a, b) => {
          const av = a[column];
          const bv = b[column];
          if (av === bv) return 0;
          if (av === null || av === undefined) return ascending ? 1 : -1;
          if (bv === null || bv === undefined) return ascending ? -1 : 1;
          return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
      const total = rows.length;
      if (this.limitTo !== null) rows = rows.slice(0, this.limitTo);

      const columns = this.rec.select ?? '*';
      const projected = rows.map((row) => project(this.table, row, columns));
      const count = this.rec.count ? total : null;

      if (this.rec.head) return { data: null, error: null, count };
      if (this.cardinality === 'many') return { data: projected, error: null, count };
      if (projected.length === 1) return { data: projected[0], error: null, count };
      if (projected.length === 0 && this.cardinality === 'maybe') return { data: null, error: null, count };
      return {
        data: null,
        error: error('PGRST116', 'JSON object requested, multiple (or no) rows returned'),
        count: null,
      };
    }
  }

  const from = vi.fn((table: string) => new Query(table));

  return {
    from,
    queries,
    /** 現在のテーブルの中身 (insert / update / delete の結果を確かめる) */
    rows: (table: string): Row[] => structuredClone(tables[table] ?? []),
    /** 指定テーブルに対する、指定した操作の記録 */
    recorded: (table: string, op?: RecordedQuery['op']) =>
      queries.filter((q) => q.table === table && (op === undefined || q.op === op)),
  };
}

export type SchemaDb = ReturnType<typeof createSchemaDb>;

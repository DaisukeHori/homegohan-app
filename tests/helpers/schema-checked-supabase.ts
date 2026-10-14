/**
 * #1306: 本番スキーマの列を知っている、状態を持つ Supabase フェイク。
 *
 * 通常のモック (tests/helpers/fake-supabase.ts) は「呼び出し順に決め打ちの結果を返す」だけなので、
 * 存在しない列を select / filter / update しても何も起きず、列名の間違いを検出できない。
 * (例: gdpr_deletion_requests に無い status を読んでいた運営画面のエクスポート API。
 *  本番では PostgREST が 42703 で失敗し、error を見ていないコードは「行が無い」と区別できなかった)
 *
 * このフェイクはリポジトリ内のスキーマ定義 (本番スキーマのスナップショット supabase/baseline/prod_schema.sql に、
 * それより新しい migration を重ねたもの。読み取りは tests/helpers/schema-snapshot.ts) から列を読み取り、
 * PostgREST と同じ形のエラー ({ code, message, details, hint }) を返す。
 *   - select / filter に存在しない列がある       → 42703 (column <table>.<col> does not exist)
 *   - insert / update の項目に存在しない列がある → PGRST204 (Could not find the '<col>' column ...)
 *   - single() で 0 件または複数件               → PGRST116
 * 取得結果は select した列だけを持つ (select しなかった列を読むコードも検出できる)。
 *
 * 検証できないもの: RLS、列の型の厳密なチェック、NOT NULL / 外部キー、埋め込みリレーション、同時実行の「本物の」並行性。
 * それらはローカル Supabase を使う結合テスト (tests/integration/security/) で確認する。
 *
 * 注意: migration の読み取りはベストエフォート (schema-snapshot.ts を参照)。読み取れなかった列を使うテストは、
 * seed が「スキーマに無い列」の例外になるので気づける。
 */
import { randomUUID } from 'node:crypto';
import { vi, type Mock } from 'vitest';
import { parseSelectItem, splitTopLevel } from './select-columns';
import { loadSchemaModel, type SchemaTable } from './schema-snapshot';

export interface PgError {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
}

export function pgError(code: string, message: string, details: string | null = null): PgError {
  return { code, message, details, hint: null };
}

type Row = Record<string, unknown>;
type Operation = 'select' | 'insert' | 'update';
type FilterKind = 'eq' | 'is' | 'gte' | 'lte' | 'lt';
export type Result = { data: unknown; error: PgError | null };

interface Filter {
  kind: FilterKind;
  column: string;
  value: unknown;
}

/**
 * フェイクが実装している PostgREST のクエリビルダーの部分。await すると { data, error } になる。
 * supabase.from(table) の戻り値の型として使う (型が無いと、テストが from(...) を呼ぶところで tsc が通らない)。
 */
export interface FakeQuery extends PromiseLike<Result> {
  select(columns?: string): FakeQuery;
  insert(payload: Record<string, unknown>): FakeQuery;
  update(payload: Record<string, unknown>): FakeQuery;
  eq(column: string, value: unknown): FakeQuery;
  is(column: string, value: unknown): FakeQuery;
  gte(column: string, value: unknown): FakeQuery;
  lte(column: string, value: unknown): FakeQuery;
  lt(column: string, value: unknown): FakeQuery;
  order(column: string, options?: { ascending?: boolean }): FakeQuery;
  limit(count: number): FakeQuery;
  single(): FakeQuery;
  maybeSingle(): FakeQuery;
}

export interface RecordedCall {
  table: string;
  op: Operation;
  /** select の列文字列。update / insert の後ろの .select() は returning として記録する */
  columns: string | null;
  /** insert / update に渡した項目 */
  payload: Row | null;
  filters: Filter[];
}

let schemaModel: Map<string, SchemaTable> | null = null;

/** リポジトリ内のスキーマ定義 (本番スナップショット + それより新しい migration) から、public テーブルの列名を取り出す */
export function schemaColumns(table: string): string[] {
  schemaModel ??= loadSchemaModel();
  const found = schemaModel.get(table);
  if (!found) throw new Error(`スキーマ定義に public.${table} のテーブルが無い`);
  if (found.columns.length === 0) throw new Error(`public.${table} の列を読み取れなかった`);
  return found.columns;
}

/** 日時の比較は Date.parse でそろえる (2026-10-07 と 2026-10-08T23:59:59Z を同じ軸で比べる)。日時でなければ値のまま */
function comparable(value: unknown): number | string | null {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : time;
}

function matches(row: Row, filter: Filter): boolean {
  const actual = row[filter.column];
  switch (filter.kind) {
    case 'eq':
      return actual === filter.value;
    case 'is':
      return filter.value === null ? actual === null || actual === undefined : actual === filter.value;
    case 'gte':
    case 'lte':
    case 'lt': {
      const a = comparable(actual);
      const b = comparable(filter.value);
      if (a === null || b === null || typeof a !== typeof b) return false;
      if (filter.kind === 'gte') return a >= b;
      return filter.kind === 'lte' ? a <= b : a < b;
    }
  }
}

export interface SchemaCheckedDb {
  /** supabase クライアントの代わりに渡す */
  supabase: { from: Mock<(table: string) => FakeQuery> };
  /** テーブルの現在の中身 (テストが直接読み書きしてよい) */
  tables: Record<string, Row[]>;
  /** 実行された select / insert / update の記録 (実行順) */
  calls: RecordedCall[];
  /** 指定テーブル・操作の次の count 回を、実行せずに指定のエラーで失敗させる */
  failNext(table: string, op: Operation, error: PgError, count?: number): void;
  /** 指定テーブル・操作が次に実行される直前にフックを実行する (別の処理が先に状態を変えた状況の再現) */
  beforeNext(table: string, op: Operation, hook: () => void): void;
}

/**
 * seed のテーブルごとに本番スキーマの列を読み、フェイクを作る。
 * seed の行に存在しない列があれば、テスト自身が間違っているので作成時に例外にする。
 */
export function createSchemaCheckedDb(seed: Record<string, Row[]>): SchemaCheckedDb {
  const columnsOf = new Map<string, string[]>();
  const tables: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(seed)) {
    const columns = schemaColumns(table);
    columnsOf.set(table, columns);
    for (const row of rows) {
      const unknown = Object.keys(row).filter((key) => !columns.includes(key));
      if (unknown.length > 0) throw new Error(`seed ${table}: スキーマに無い列 ${unknown.join(', ')}`);
    }
    tables[table] = rows.map((row) => ({ ...row }));
  }

  const calls: RecordedCall[] = [];
  const injected: Array<{ table: string; op: Operation; error: PgError; remaining: number }> = [];
  const hooks: Array<{ table: string; op: Operation; hook: () => void }> = [];

  function columnsFor(table: string): string[] {
    const columns = columnsOf.get(table);
    if (!columns) throw new Error(`schema-checked-supabase: テーブル ${table} は seed に無い`);
    return columns;
  }

  function missingColumn(table: string, column: string): PgError {
    return pgError('42703', `column ${table}.${column} does not exist`);
  }

  /** select の列文字列を検証して列名の配列にする。'*' は全列 */
  function parseColumns(table: string, columns: string): { names: string[] } | { error: PgError } {
    const known = columnsFor(table);
    const names: string[] = [];
    for (const item of splitTopLevel(columns)) {
      if (item.trim() === '*') {
        names.push(...known);
        continue;
      }
      const parsed = parseSelectItem(item);
      if (!parsed || parsed.kind !== 'column') {
        throw new Error(`schema-checked-supabase: ${table} の select ${item} は未対応`);
      }
      if (!known.includes(parsed.name)) return { error: missingColumn(table, parsed.name) };
      names.push(parsed.name);
    }
    return { names };
  }

  class Query implements FakeQuery {
    private op: Operation = 'select';
    private columns: string | null = null;
    private payload: Row | null = null;
    private filters: Filter[] = [];
    private sortBy: { column: string; ascending: boolean } | null = null;
    private max: number | null = null;
    private mode: 'many' | 'single' | 'maybeSingle' = 'many';

    constructor(private readonly table: string) {}

    select(columns = '*') {
      // update / insert の後ろに付いた select は、更新した行を返させる (returning)
      this.columns = columns;
      return this;
    }
    insert(payload: Row) {
      this.op = 'insert';
      this.payload = payload;
      return this;
    }
    update(payload: Row) {
      this.op = 'update';
      this.payload = payload;
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push({ kind: 'eq', column, value });
      return this;
    }
    is(column: string, value: unknown) {
      this.filters.push({ kind: 'is', column, value });
      return this;
    }
    gte(column: string, value: unknown) {
      this.filters.push({ kind: 'gte', column, value });
      return this;
    }
    lte(column: string, value: unknown) {
      this.filters.push({ kind: 'lte', column, value });
      return this;
    }
    lt(column: string, value: unknown) {
      this.filters.push({ kind: 'lt', column, value });
      return this;
    }
    order(column: string, options?: { ascending?: boolean }) {
      this.sortBy = { column, ascending: options?.ascending ?? true };
      return this;
    }
    limit(count: number) {
      this.max = count;
      return this;
    }
    single() {
      this.mode = 'single';
      return this;
    }
    maybeSingle() {
      this.mode = 'maybeSingle';
      return this;
    }

    then<T1 = Result, T2 = never>(
      onfulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
      onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
    ): PromiseLike<T1 | T2> {
      return Promise.resolve().then(() => this.execute()).then(onfulfilled, onrejected);
    }

    private execute(): Result {
      const { table, op } = this;
      const hookIndex = hooks.findIndex((h) => h.table === table && h.op === op);
      if (hookIndex >= 0) hooks.splice(hookIndex, 1)[0].hook();

      calls.push({ table, op, columns: this.columns, payload: this.payload, filters: [...this.filters] });

      const failure = injected.find((e) => e.table === table && e.op === op && e.remaining > 0);
      if (failure) {
        failure.remaining -= 1;
        return { data: null, error: failure.error };
      }

      const known = columnsFor(table);
      for (const filter of this.filters) {
        if (!known.includes(filter.column)) return { data: null, error: missingColumn(table, filter.column) };
      }
      // order にも存在しない列は使えない (PostgREST は 42703)
      if (this.sortBy && !known.includes(this.sortBy.column)) {
        return { data: null, error: missingColumn(table, this.sortBy.column) };
      }
      let returning: string[] | null = null;
      if (this.columns !== null) {
        const parsed = parseColumns(table, this.columns);
        if ('error' in parsed) return { data: null, error: parsed.error };
        returning = parsed.names;
      }

      const project = (row: Row): Row =>
        Object.fromEntries((returning ?? []).map((name) => [name, row[name] ?? null]));

      if (op === 'select') {
        let rows = tables[table].filter((row) => this.filters.every((f) => matches(row, f)));
        if (this.sortBy) {
          const { column, ascending } = this.sortBy;
          rows = [...rows].sort((a, b) => {
            const x = comparable(a[column]);
            const y = comparable(b[column]);
            if (x === y) return 0;
            if (x === null) return 1;
            if (y === null) return -1;
            return (x < y ? -1 : 1) * (ascending ? 1 : -1);
          });
        }
        if (this.max !== null) rows = rows.slice(0, this.max);
        return this.shape(rows.map(project));
      }

      // insert / update: 項目の列を検証する
      const payload = this.payload ?? {};
      const unknownKey = Object.keys(payload).find((key) => !known.includes(key));
      if (unknownKey) {
        return {
          data: null,
          error: pgError('PGRST204', `Could not find the '${unknownKey}' column of '${table}' in the schema cache`),
        };
      }

      let affected: Row[];
      if (op === 'insert') {
        const row: Row = { ...(known.includes('id') ? { id: randomUUID() } : {}), ...payload };
        tables[table].push(row);
        affected = [row];
      } else {
        affected = tables[table].filter((row) => this.filters.every((f) => matches(row, f)));
        for (const row of affected) Object.assign(row, payload);
      }
      // .select() が付いていなければ、PostgREST は本文を返さない
      return returning === null ? { data: null, error: null } : this.shape(affected.map(project));
    }

    private shape(rows: Row[]): Result {
      if (this.mode === 'many') return { data: rows, error: null };
      if (rows.length === 1) return { data: rows[0], error: null };
      if (rows.length === 0 && this.mode === 'maybeSingle') return { data: null, error: null };
      return {
        data: null,
        error: pgError(
          'PGRST116',
          'JSON object requested, multiple (or no) rows returned',
          `The result contains ${rows.length} rows`,
        ),
      };
    }
  }

  return {
    supabase: { from: vi.fn((table: string) => new Query(table)) },
    tables,
    calls,
    failNext(table, op, error, count = 1) {
      injected.push({ table, op, error, remaining: count });
    },
    beforeNext(table, op, hook) {
      hooks.push({ table, op, hook });
    },
  };
}

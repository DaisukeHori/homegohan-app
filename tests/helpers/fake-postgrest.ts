/**
 * ユニットテスト用の簡易 PostgREST (supabase-js のクエリビルダー) の再現。
 *
 * fake-supabase.ts は「テーブルごとに用意した結果をそのまま返す」だけだが、こちらは行の配列を持ち、
 * コードが付けた絞り込み (.eq) を実際に適用して返す。そのため「絞り込みを付け忘れると他人の行が返る」
 * ことをテストで再現できる (個人データエクスポート #1131 のスコープ検証用)。
 *
 * 再現する範囲 (エクスポートが使う部分だけ):
 *   - .select(columns, { count: 'exact' })  列の指定 / 'tbl!inner(col)' / 'alias:tbl(col,...)' の埋め込み
 *   - .eq(column, value)                     'tbl.col' 形式の埋め込み先の絞り込みを含む
 *   - .order(column) / .range(from, to)
 *   - max_rows (1 回の応答の最大行数) と、テーブル単位のエラー
 */
import { vi } from 'vitest';

export type FakeRow = Record<string, unknown>;

export interface FakePostgrestOptions {
  tables: Record<string, FakeRow[]>;
  /** 子テーブル -> (埋め込む親テーブル名 -> 子の外部キー列)。PostgREST の関係の解決を再現する */
  relations?: Record<string, Record<string, string>>;
  /** テーブル名 -> 返すエラー */
  errors?: Record<string, { message: string; code?: string }>;
  /** true なら .eq の絞り込みを無視する (コードが絞り込みを忘れた / RLS が他人の行を返す状況の再現) */
  ignoreFilters?: boolean;
  /** 1 回の応答で返す最大行数 (PostgREST の max_rows) */
  maxRows?: number;
}

export interface RecordedQuery {
  table: string;
  select: string;
  count: boolean;
  eq: Array<[string, unknown]>;
  order: string[];
  range: [number, number] | null;
}

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

function pick(row: FakeRow, columns: string): FakeRow {
  if (columns.trim() === '*') return { ...row };
  const out: FakeRow = {};
  for (const col of splitTopLevel(columns)) out[col] = row[col];
  return out;
}

export function createFakePostgrest(options: FakePostgrestOptions) {
  const queries: RecordedQuery[] = [];

  function execute(rec: RecordedQuery) {
    const error = options.errors?.[rec.table];
    if (error) return { data: null, error, count: null };

    const source = options.tables[rec.table] ?? [];

    const matches = (row: FakeRow): boolean => {
      if (options.ignoreFilters) return true;
      return rec.eq.every(([column, value]) => {
        if (!column.includes('.')) return row[column] === value;
        const [parentName, parentColumn] = column.split('.');
        const fk = options.relations?.[rec.table]?.[parentName];
        if (!fk) throw new Error(`fake-postgrest: no relation ${rec.table} -> ${parentName}`);
        const parent = (options.tables[parentName] ?? []).find((p) => p.id === row[fk]);
        return parent?.[parentColumn] === value;
      });
    };

    const filtered = source.filter(matches);
    const sorted = [...filtered].sort((a, b) => {
      for (const column of rec.order) {
        const av = a[column] as string | number;
        const bv = b[column] as string | number;
        if (av < bv) return -1;
        if (av > bv) return 1;
      }
      return 0;
    });

    const [from, to] = rec.range ?? [0, sorted.length - 1];
    let page = sorted.slice(from, to + 1);
    if (options.maxRows !== undefined) page = page.slice(0, options.maxRows);

    const selectParts = splitTopLevel(rec.select);
    const wantsAll = selectParts.includes('*');
    const plainColumns = selectParts.filter((p) => !p.includes('('));
    const embeds = selectParts.filter((p) => p.includes('('));

    const data = page.map((row) => {
      const out: FakeRow = wantsAll ? { ...row } : {};
      for (const col of plainColumns) if (col !== '*') out[col] = row[col];
      for (const embed of embeds) {
        // 'alias:table(cols)' / 'table!inner(cols)' / 'table!fk_column!inner(cols)' / 'table(cols)'
        const m = embed.match(/^(?:([a-z_]+):)?([a-z_]+)(?:![a-z_]+)*\((.*)\)$/);
        if (!m) throw new Error(`fake-postgrest: cannot parse embed "${embed}"`);
        const [, alias, tableName, cols] = m;
        const fk = options.relations?.[rec.table]?.[tableName];
        if (!fk) throw new Error(`fake-postgrest: no relation ${rec.table} -> ${tableName}`);
        const parent = (options.tables[tableName] ?? []).find((p) => p.id === row[fk]);
        out[alias ?? tableName] = parent ? pick(parent, cols) : null;
      }
      return structuredClone(out);
    });

    return { data, error: null, count: rec.count ? filtered.length : null };
  }

  const from = vi.fn((table: string) => ({
    select(columns: string, selectOptions?: { count?: string }) {
      const rec: RecordedQuery = {
        table,
        select: columns,
        count: selectOptions?.count === 'exact',
        eq: [],
        order: [],
        range: null,
      };
      queries.push(rec);
      const builder = {
        eq(column: string, value: unknown) {
          rec.eq.push([column, value]);
          return builder;
        },
        order(column: string) {
          rec.order.push(column);
          return builder;
        },
        range(fromIndex: number, toIndex: number) {
          rec.range = [fromIndex, toIndex];
          return builder;
        },
        then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
          return Promise.resolve(execute(rec)).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  }));

  return { from, queries };
}

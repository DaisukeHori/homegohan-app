/**
 * AI 相談のアクション add_recipe_to_collection (src/lib/ai/consultation-action-executor.ts) の単体テスト用の、
 * recipe_collections だけを持つ Supabase の作り物 (#2166 X4・#2178 Y3)。
 *
 * eq / order / limit / single / maybeSingle / insert / upsert / update を、実物の PostgREST と同じ意味で扱う:
 *   - .single() は 1 行ちょうどでなければエラー (PGRST116)、.maybeSingle() は 2 行以上でエラー・0 行は null
 *   - 一意の索引 (user_id, name) を持つ (#2178 Y3-b)。同じ利用者・同じ名前の行の insert は一意の違反 (23505)
 *   - upsert は onConflict が索引の列 (user_id,name) のときだけ受け付け、同じ名前の行があればその行を返す (行は増えない)
 *
 * 読み取りは 2 種類に分けて記録・失敗させる: 名前で引く読み取り (user_id と name で絞る = 'lookup') と、
 * 足す前の recipe_ids の読み直し (id で絞る = 'reread')。
 */
import { expect } from 'vitest';
import type { ListOrderKey } from '@/lib/api/list-order';
import {
  RECIPE_COLLECTIONS_USER_NAME_CONFLICT_TARGET,
  RECIPE_COLLECTIONS_USER_NAME_UNIQUE_INDEX,
} from '@/lib/recipes/collections';
import { UNIQUE_VIOLATION_SQLSTATE } from './recipe-collections-user-name-unique';

export interface CollectionRow {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  recipe_ids: string[] | null;
}

export interface PgError {
  message: string;
  code: string;
}

/** 失敗させる操作の種類 */
export type FakeCollectionsOp = 'lookup' | 'reread' | 'insert' | 'upsert' | 'update';

/** PostgREST の .single() / .maybeSingle() が行の数の違いで返すエラーのコード */
const PGRST_SINGLE_ROW_CODE = 'PGRST116';
/** 作り物が作った行の created_at (テストの seed より新しい日時) */
const FAKE_CREATED_AT = '2026-11-01T09:00:00.000Z';

export interface FakeCollectionsHooks {
  /** 名前で引く読み取りが返った直後に呼ぶ (読み取りと作成のあいだに別の実行が同じ名前の行を作った、を再現する) */
  afterNameLookup?: (rows: CollectionRow[]) => void;
  /** recipe_ids の読み直しの直前に呼ぶ (読み直しの前に行が消えた、を再現する) */
  beforeReread?: (rows: CollectionRow[]) => void;
}

type QueryOp = 'select' | 'insert' | 'upsert' | 'update';

export function createFakeCollectionsDb(seed: CollectionRow[], hooks: FakeCollectionsHooks = {}) {
  const rows: CollectionRow[] = seed.map((row) => ({ ...row, recipe_ids: row.recipe_ids === null ? null : [...row.recipe_ids] }));
  /** 名前で引く select (user_id と name で絞る読み取り) の order / limit の記録 */
  const nameLookups: Array<{ orders: ListOrderKey[]; limit: number | null }> = [];
  const inserts: Array<Record<string, unknown>> = [];
  const upserts: Array<{ values: Record<string, unknown>; options: Record<string, unknown> | undefined }> = [];
  /** update の記録 (絞った列と値・書いた値) */
  const updates: Array<{ filters: Array<[string, unknown]>; values: Record<string, unknown> }> = [];
  /** recipe_ids の読み直しの回数 */
  let rereadCount = 0;
  const failures: Partial<Record<FakeCollectionsOp, PgError>> = {};
  /** 読み直しを、エラーも行も無い ({ data: null, error: null }) で返す */
  let rereadReturnsNull = false;
  let nextId = 1;

  const compare = (a: CollectionRow, b: CollectionRow, orders: ListOrderKey[]): number => {
    for (const { column, options } of orders) {
      const left = String(a[column as keyof CollectionRow]);
      const right = String(b[column as keyof CollectionRow]);
      if (left !== right) return (left < right ? -1 : 1) * (options.ascending ? 1 : -1);
    }
    return 0;
  };

  const sameName = (userId: unknown, name: unknown) => rows.find((row) => row.user_id === userId && row.name === name);

  const createRow = (values: Record<string, unknown>): CollectionRow => {
    const row: CollectionRow = {
      id: `collection-new-${nextId++}`,
      user_id: String(values.user_id),
      name: String(values.name),
      created_at: FAKE_CREATED_AT,
      recipe_ids: [],
    };
    rows.push(row);
    return row;
  };

  const uniqueViolation = (): PgError => ({
    message: `duplicate key value violates unique constraint "${RECIPE_COLLECTIONS_USER_NAME_UNIQUE_INDEX}"`,
    code: UNIQUE_VIOLATION_SQLSTATE,
  });

  const makeQuery = (table: string) => {
    expect(table).toBe('recipe_collections');
    let op: QueryOp = 'select';
    let payload: Record<string, unknown> = {};
    let upsertOptions: Record<string, unknown> | undefined;
    const filters: Array<[string, unknown]> = [];
    const orders: ListOrderKey[] = [];
    let limit: number | null = null;

    const matched = () =>
      rows.filter((row) => filters.every(([column, value]) => row[column as keyof CollectionRow] === value));

    const isNameLookup = () => {
      const columns = filters.map(([column]) => column);
      return columns.includes('user_id') && columns.includes('name');
    };

    /** 実行し、select の対象の行を返す。null の data は「エラーも行も無い」 */
    const run = (): { data: CollectionRow[] | null; error: PgError | null } => {
      if (op === 'insert') {
        const failure = failures.insert;
        if (failure) return { data: null, error: failure };
        inserts.push(payload);
        if (sameName(payload.user_id, payload.name)) return { data: null, error: uniqueViolation() };
        return { data: [createRow(payload)], error: null };
      }
      if (op === 'upsert') {
        upserts.push({ values: payload, options: upsertOptions });
        const failure = failures.upsert;
        if (failure) return { data: null, error: failure };
        // PostgREST は on_conflict の列に一意の索引が無いと 42P10 で失敗する。作り物は索引の列だけを受け付ける
        expect(upsertOptions?.onConflict).toBe(RECIPE_COLLECTIONS_USER_NAME_CONFLICT_TARGET);
        const existing = sameName(payload.user_id, payload.name);
        if (existing) {
          if (upsertOptions?.ignoreDuplicates === true) return { data: [], error: null };
          Object.assign(existing, payload);
          return { data: [existing], error: null };
        }
        return { data: [createRow(payload)], error: null };
      }
      if (op === 'update') {
        const failure = failures.update;
        if (failure) return { data: null, error: failure };
        updates.push({ filters: [...filters], values: payload });
        const targets = matched();
        for (const row of targets) Object.assign(row, payload);
        return { data: targets, error: null };
      }
      if (isNameLookup()) {
        nameLookups.push({ orders: [...orders], limit });
        const failure = failures.lookup;
        if (failure) return { data: null, error: failure };
        const sorted = [...matched()].sort((a, b) => compare(a, b, orders));
        const found = limit === null ? sorted : sorted.slice(0, limit);
        hooks.afterNameLookup?.(rows);
        return { data: found, error: null };
      }
      rereadCount += 1;
      hooks.beforeReread?.(rows);
      const failure = failures.reread;
      if (failure) return { data: null, error: failure };
      if (rereadReturnsNull) return { data: null, error: null };
      return { data: matched(), error: null };
    };

    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      },
      order: (column: string, options: ListOrderKey['options']) => {
        orders.push({ column, options });
        return builder;
      },
      limit: (count: number) => {
        limit = count;
        return builder;
      },
      insert: (values: Record<string, unknown>) => {
        op = 'insert';
        payload = values;
        return builder;
      },
      upsert: (values: Record<string, unknown>, options?: Record<string, unknown>) => {
        op = 'upsert';
        payload = values;
        upsertOptions = options;
        return builder;
      },
      update: (values: Record<string, unknown>) => {
        op = 'update';
        payload = values;
        return builder;
      },
      /** PostgREST の .single(): 1 行ちょうどでなければエラー (PGRST116) */
      single: async () => {
        const { data, error } = run();
        if (error) return { data: null, error };
        if (data === null) return { data: null, error: null };
        if (data.length !== 1) {
          return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: PGRST_SINGLE_ROW_CODE } };
        }
        return { data: data[0], error: null };
      },
      /** PostgREST の .maybeSingle(): 0 行は null、2 行以上はエラー */
      maybeSingle: async () => {
        const { data, error } = run();
        if (error) return { data: null, error };
        if (data !== null && data.length > 1) {
          return { data: null, error: { message: 'JSON object requested, multiple rows returned', code: PGRST_SINGLE_ROW_CODE } };
        }
        return { data: data?.[0] ?? null, error: null };
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
        const { error } = run();
        return Promise.resolve({ data: null, error }).then(resolve, reject);
      },
    };
    return builder;
  };

  return {
    rows,
    nameLookups,
    inserts,
    upserts,
    updates,
    get rereadCount() {
      return rereadCount;
    },
    failOn(op: FakeCollectionsOp, error: PgError) {
      failures[op] = error;
    },
    /** recipe_ids の読み直しを { data: null, error: null } で返す */
    rereadWithoutRow() {
      rereadReturnsNull = true;
    },
    supabase: { from: (table: string) => makeQuery(table) },
  };
}

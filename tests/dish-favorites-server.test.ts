/**
 * tests/dish-favorites-server.test.ts
 *
 * 献立の料理のお気に入りの DB の操作 (src/modules/dish-favorites/server.ts) の単体テスト (#2011)。
 * 設計書 docs/design/cross/22-dish-favorites.md §7.4・§7.15・§7.15.1・§12 の V-1〜V-10。
 *
 * DB は tests/helpers/scripted-supabase.ts の偽物 (from を呼んだ順に、決めておいた結果を返す) で置き換え、
 * builder に掛けた呼び出し (メソッド名と引数) を queries[n].calls で確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DISH_FAVORITES_MAX_PER_USER_DEFAULT,
  DishSnapshotSchema,
  dishNameKeyOf,
  toDishFavorite,
  type DishFavoriteRow,
  type SaveDishFavoriteBody,
} from '@/modules/dish-favorites/core';
import {
  DISH_FAVORITES_TABLE,
  countDishFavorites,
  deleteDishFavorite,
  dishFavoritesMaxPerUser,
  findDishFavoriteByName,
  listDishFavorites,
  saveDishFavorite,
  type DishFavoritesDb,
  type ListDishFavoritesQuery,
} from '@/modules/dish-favorites/server';
import { createScriptedSupabase, type ScriptedResult, type ScriptedSupabase } from './helpers/scripted-supabase';

// resolveBeyondLastPage (src/lib/api/list-range.ts) が数え直しの失敗を記録する構造化ログ。本物は app_logs へ書きに行くので差し替える
const mocks = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: mocks.logError,
    withUser: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: mocks.logError }),
  }),
  generateRequestId: () => 'req_test',
}));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FAVORITE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_FAVORITE_ID = '33333333-3333-4333-8333-333333333333';
const PLANNED_MEAL_ID = '44444444-4444-4444-8444-444444444444';
const ROUTE_NAME = 'GET /api/favorites';

/** server.ts が select する列 (正典 §7.4 の ROW_COLUMNS。DishFavoriteRowSchema と同じ) */
const EXPECTED_ROW_COLUMNS = 'id, user_id, dish_name, dish_name_key, dish, source_planned_meal_id, created_at, updated_at';

function rowOf(overrides: Partial<DishFavoriteRow> = {}): DishFavoriteRow {
  return {
    id: FAVORITE_ID,
    user_id: USER_ID,
    dish_name: '肉じゃが',
    dish_name_key: '肉じゃが',
    dish: DishSnapshotSchema.parse({ name: '肉じゃが' }),
    source_planned_meal_id: null,
    created_at: '2026-10-25T00:00:00.000Z',
    updated_at: '2026-10-25T00:00:00.000Z',
    ...overrides,
  };
}

function dbOf(scripted: ScriptedSupabase): DishFavoritesDb {
  return scripted.db as unknown as DishFavoritesDb;
}

function scriptedOf(...results: ScriptedResult[]): ScriptedSupabase {
  return createScriptedSupabase(results);
}

function query(overrides: Partial<ListDishFavoritesQuery> = {}): ListDishFavoritesQuery {
  return { q: '', sort: 'newest', offset: 0, limit: 50, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('dishFavoritesMaxPerUser (V-1)', () => {
  it('V-1 dishFavoritesMaxPerUser は正の整数の環境変数を使い、未設定・空・0・負・小数・数字でない値は既定の 300', () => {
    expect(DISH_FAVORITES_MAX_PER_USER_DEFAULT).toBe(300);

    expect(dishFavoritesMaxPerUser('1')).toBe(1);
    expect(dishFavoritesMaxPerUser('12')).toBe(12);
    expect(dishFavoritesMaxPerUser(' 450 ')).toBe(450);

    for (const value of [undefined, '', '   ', '0', '-5', '1.5', 'abc', '12abc', 'NaN', 'Infinity', '1e400', '99999999999999999999']) {
      expect(dishFavoritesMaxPerUser(value), String(value)).toBe(DISH_FAVORITES_MAX_PER_USER_DEFAULT);
    }

    // 引数を省くと環境変数 DISH_FAVORITES_MAX_PER_USER を読む
    vi.stubEnv('DISH_FAVORITES_MAX_PER_USER', '7');
    expect(dishFavoritesMaxPerUser()).toBe(7);
    vi.stubEnv('DISH_FAVORITES_MAX_PER_USER', '0');
    expect(dishFavoritesMaxPerUser()).toBe(DISH_FAVORITES_MAX_PER_USER_DEFAULT);
  });
});

describe('listDishFavorites (V-2〜V-4)', () => {
  it('V-2 listDishFavorites は user_id で絞り、q の ilike・sort ごとの order (newest = created_at desc / oldest = asc / name = dish_name_key) と id の order・range を掛ける', async () => {
    const cases = [
      ['newest', ['created_at', { ascending: false }]],
      ['oldest', ['created_at', { ascending: true }]],
      ['name', ['dish_name_key', { ascending: true }]],
    ] as const;

    for (const [sort, firstOrder] of cases) {
      const other = rowOf({ id: OTHER_FAVORITE_ID, dish_name: 'カレー', dish_name_key: 'カレー', dish: DishSnapshotSchema.parse({ name: 'カレー' }) });
      const scripted = scriptedOf({ data: [rowOf(), other], count: 7, status: 206 });

      const result = await listDishFavorites(dbOf(scripted), USER_ID, query({ q: 'じゃが', sort, offset: 20, limit: 10 }), ROUTE_NAME);

      expect(result).toEqual({ ok: true, favorites: [toDishFavorite(rowOf()), toDishFavorite(other)], total: 7 });
      expect(scripted.queries).toHaveLength(1);
      expect(scripted.queries[0].table).toBe(DISH_FAVORITES_TABLE);
      expect(scripted.queries[0].calls).toEqual([
        { method: 'select', args: [EXPECTED_ROW_COLUMNS, { count: 'exact' }] },
        { method: 'eq', args: ['user_id', USER_ID] },
        { method: 'ilike', args: ['dish_name', '%じゃが%'] },
        { method: 'order', args: [...firstOrder] },
        { method: 'order', args: ['id', { ascending: true }] },
        { method: 'range', args: [20, 29] },
      ]);
    }

    // q が空なら ilike を掛けない
    const scripted = scriptedOf({ data: [], count: 0 });
    await listDishFavorites(dbOf(scripted), USER_ID, query(), ROUTE_NAME);
    expect(scripted.queries[0].calls.map((call) => call.method)).toEqual(['select', 'eq', 'order', 'order', 'range']);
    expect(scripted.queries[0].calls[4]).toEqual({ method: 'range', args: [0, 49] });
  });

  it('V-3 listDishFavorites は 416 のとき同じ絞り込みの head の count で数え直し、空の一覧と件数を返す', async () => {
    const scripted = scriptedOf(
      { error: { code: 'PGRST103', message: 'Requested range not satisfiable' }, status: 416 },
      { count: 7 },
    );

    const result = await listDishFavorites(dbOf(scripted), USER_ID, query({ q: 'カレー', sort: 'name', offset: 100 }), ROUTE_NAME);

    expect(result).toEqual({ ok: true, favorites: [], total: 7 });
    expect(scripted.queries).toHaveLength(2);
    expect(scripted.queries[1].table).toBe(DISH_FAVORITES_TABLE);
    expect(scripted.queries[1].calls[0]).toEqual({ method: 'select', args: [EXPECTED_ROW_COLUMNS, { count: 'exact', head: true }] });
    // 数え直しも一覧と同じ絞り込み (user_id・ilike) で数える。並び順と範囲は掛けない
    expect(scripted.queries[1].calls).toEqual([
      { method: 'select', args: [EXPECTED_ROW_COLUMNS, { count: 'exact', head: true }] },
      { method: 'eq', args: ['user_id', USER_ID] },
      { method: 'ilike', args: ['dish_name', '%カレー%'] },
    ]);
    const firstIlike = scripted.queries[0].calls.find((call) => call.method === 'ilike');
    expect(scripted.queries[1].calls[2]).toEqual(firstIlike);

    // 本文が壊れて code が取れない 416 (ローカルの PostgREST) も、HTTP のステータスで数え直す
    const broken = scriptedOf({ error: { message: '{"' }, status: 416 }, { count: 3 });
    expect(await listDishFavorites(dbOf(broken), USER_ID, query({ offset: 100 }), ROUTE_NAME)).toEqual({ ok: true, favorites: [], total: 3 });
    expect(broken.queries).toHaveLength(2);
  });

  it('V-4 listDishFavorites は DB の失敗と、正典の形でない行を失敗にする (0 件にしない)', async () => {
    const dbError = { code: '42501', message: 'permission denied for table dish_favorites' };
    const failed = scriptedOf({ error: dbError, status: 403 });
    expect(await listDishFavorites(dbOf(failed), USER_ID, query(), ROUTE_NAME)).toEqual({ ok: false, error: dbError });
    // 416 以外の失敗は数え直さない
    expect(failed.queries).toHaveLength(1);

    // 416 で数え直しも失敗したら、元の失敗のまま
    const recountFailed = scriptedOf(
      { error: { code: 'PGRST103', message: 'Requested range not satisfiable' }, status: 416 },
      { error: { code: '57014', message: 'canceling statement due to statement timeout' } },
    );
    const recountResult = await listDishFavorites(dbOf(recountFailed), USER_ID, query({ offset: 100 }), ROUTE_NAME);
    expect(recountResult).toEqual({ ok: false, error: { code: 'PGRST103', message: 'Requested range not satisfiable' } });
    expect(mocks.logError).toHaveBeenCalledTimes(1);

    // 1 行でも正典の形でなければ (id が uuid でない・dish の名前が空)、一覧全体を失敗にする
    for (const broken of [{ ...rowOf(), id: 'not-a-uuid' }, { ...rowOf(), dish: { name: '' } }, { ...rowOf(), user_id: undefined }]) {
      const scripted = scriptedOf({ data: [rowOf({ id: OTHER_FAVORITE_ID }), broken], count: 2 });
      const result = await listDishFavorites(dbOf(scripted), USER_ID, query(), ROUTE_NAME);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect((result.error as Error).message).toContain('DishFavoriteRowSchema');
      }
    }
  });
});

describe('findDishFavoriteByName・countDishFavorites (V-5)', () => {
  it('V-5 findDishFavoriteByName は dish_name_key (dishNameKeyOf) で maybeSingle し、無ければ null', async () => {
    const rawName = '  ＮＩＫＵ　じゃが  ';
    const found = scriptedOf({ data: rowOf() });

    expect(await findDishFavoriteByName(dbOf(found), USER_ID, rawName)).toEqual({ ok: true, favorite: toDishFavorite(rowOf()) });
    expect(found.queries).toHaveLength(1);
    expect(found.queries[0].table).toBe(DISH_FAVORITES_TABLE);
    expect(dishNameKeyOf(rawName)).toBe('niku じゃが');
    expect(found.queries[0].calls).toEqual([
      { method: 'select', args: [EXPECTED_ROW_COLUMNS] },
      { method: 'eq', args: ['user_id', USER_ID] },
      { method: 'eq', args: ['dish_name_key', 'niku じゃが'] },
      { method: 'maybeSingle', args: [] },
    ]);

    const missing = scriptedOf({ data: null });
    expect(await findDishFavoriteByName(dbOf(missing), USER_ID, '肉じゃが')).toEqual({ ok: true, favorite: null });

    const dbError = { code: '57014', message: 'timeout' };
    expect(await findDishFavoriteByName(dbOf(scriptedOf({ error: dbError })), USER_ID, '肉じゃが')).toEqual({ ok: false, error: dbError });

    const broken = await findDishFavoriteByName(dbOf(scriptedOf({ data: { ...rowOf(), id: 'not-a-uuid' } })), USER_ID, '肉じゃが');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toBeInstanceOf(Error);

    // 件数は行を取らずに数える
    const counted = scriptedOf({ count: 12 });
    expect(await countDishFavorites(dbOf(counted), USER_ID)).toEqual({ ok: true, count: 12 });
    expect(counted.queries[0].calls).toEqual([
      { method: 'select', args: ['id', { count: 'exact', head: true }] },
      { method: 'eq', args: ['user_id', USER_ID] },
    ]);
    expect(await countDishFavorites(dbOf(scriptedOf({ count: null })), USER_ID)).toEqual({ ok: true, count: 0 });
    expect(await countDishFavorites(dbOf(scriptedOf({ error: dbError })), USER_ID)).toEqual({ ok: false, error: dbError });
  });
});

describe('saveDishFavorite (V-6〜V-9)', () => {
  const body: SaveDishFavoriteBody = { dish: DishSnapshotSchema.parse({ name: '肉じゃが' }), source_planned_meal_id: PLANNED_MEAL_ID };
  const MAX = 3;

  it('V-6 saveDishFavorite は同じ鍵の行が無ければ件数を数え、上限以上なら limit (upsert しない)', async () => {
    for (const count of [MAX, MAX + 1]) {
      const scripted = scriptedOf({ data: null }, { count });

      expect(await saveDishFavorite(dbOf(scripted), USER_ID, body, MAX)).toEqual({ ok: false, reason: 'limit', max: MAX });
      expect(scripted.queries).toHaveLength(2);
      expect(scripted.queries[0].calls).toEqual([
        { method: 'select', args: ['id'] },
        { method: 'eq', args: ['user_id', USER_ID] },
        { method: 'eq', args: ['dish_name_key', '肉じゃが'] },
        { method: 'maybeSingle', args: [] },
      ]);
      expect(scripted.queries[1].calls).toEqual([
        { method: 'select', args: ['id', { count: 'exact', head: true }] },
        { method: 'eq', args: ['user_id', USER_ID] },
      ]);
    }

    // 上限より 1 少なければ作る (created: true)
    const scripted = scriptedOf({ data: null }, { count: MAX - 1 }, { data: rowOf({ source_planned_meal_id: PLANNED_MEAL_ID }) });
    expect(await saveDishFavorite(dbOf(scripted), USER_ID, body, MAX)).toEqual({
      ok: true,
      favorite: toDishFavorite(rowOf({ source_planned_meal_id: PLANNED_MEAL_ID })),
      created: true,
    });
    expect(scripted.queries).toHaveLength(3);
    expect(scripted.queries[2].calls.map((call) => call.method)).toEqual(['upsert', 'select', 'single']);
  });

  it('V-7 saveDishFavorite は同じ鍵の行があれば件数を数えずに upsert し created: false', async () => {
    // 件数が上限に達していても、保存済みの名前の置き換えは件数を増やさないので断らない
    const scripted = scriptedOf({ data: { id: FAVORITE_ID } }, { data: rowOf() });

    expect(await saveDishFavorite(dbOf(scripted), USER_ID, body, MAX)).toEqual({ ok: true, favorite: toDishFavorite(rowOf()), created: false });
    expect(scripted.queries).toHaveLength(2);
    expect(scripted.queries[1].calls.map((call) => call.method)).toEqual(['upsert', 'select', 'single']);
    expect(scripted.queries[1].calls.some((call) => call.method === 'select' && JSON.stringify(call.args).includes('head'))).toBe(false);
  });

  it('V-8 saveDishFavorite は onConflict user_id,dish_name_key で upsert し、dish_name を表示名・dish.name も表示名にそろえる', async () => {
    // 呼び出し側が Zod を通さずに渡した名前 (前後と途中の空白・全角英字) でも、表示名と鍵にそろえて書く
    const rawBody: SaveDishFavoriteBody = {
      dish: { ...DishSnapshotSchema.parse({ name: '肉じゃが', ingredients: ['じゃがいも 2個'] }), name: '  ＮＩＫＵ　　じゃが ' },
      source_planned_meal_id: null,
    };
    const scripted = scriptedOf({ data: null }, { count: 0 }, { data: rowOf() });

    await saveDishFavorite(dbOf(scripted), USER_ID, rawBody, MAX);

    expect(scripted.queries[2].table).toBe(DISH_FAVORITES_TABLE);
    expect(scripted.queries[2].calls).toEqual([
      {
        method: 'upsert',
        args: [
          {
            user_id: USER_ID,
            dish_name: 'ＮＩＫＵ じゃが',
            dish_name_key: 'niku じゃが',
            dish: { ...rawBody.dish, name: 'ＮＩＫＵ じゃが' },
            source_planned_meal_id: null,
          },
          { onConflict: 'user_id,dish_name_key' },
        ],
      },
      { method: 'select', args: [EXPECTED_ROW_COLUMNS] },
      { method: 'single', args: [] },
    ]);
    // 確認の問い合わせも同じ鍵で引く
    expect(scripted.queries[0].calls).toContainEqual({ method: 'eq', args: ['dish_name_key', 'niku じゃが'] });
  });

  it("V-9 saveDishFavorite は DB の失敗 (確認・件数・upsert) を reason: 'db' で返す", async () => {
    const dbError = { code: '57014', message: 'timeout' };

    const checkFailed = scriptedOf({ error: dbError });
    expect(await saveDishFavorite(dbOf(checkFailed), USER_ID, body, MAX)).toEqual({ ok: false, reason: 'db', error: dbError });
    expect(checkFailed.queries).toHaveLength(1);

    const countFailed = scriptedOf({ data: null }, { error: dbError });
    expect(await saveDishFavorite(dbOf(countFailed), USER_ID, body, MAX)).toEqual({ ok: false, reason: 'db', error: dbError });
    expect(countFailed.queries).toHaveLength(2);

    const upsertFailed = scriptedOf({ data: { id: FAVORITE_ID } }, { error: dbError });
    expect(await saveDishFavorite(dbOf(upsertFailed), USER_ID, body, MAX)).toEqual({ ok: false, reason: 'db', error: dbError });

    // upsert が返した行が正典の形でないときも db の失敗
    const brokenRow = await saveDishFavorite(dbOf(scriptedOf({ data: { id: FAVORITE_ID } }, { data: { ...rowOf(), id: 'x' } })), USER_ID, body, MAX);
    expect(brokenRow).toMatchObject({ ok: false, reason: 'db' });
    if (!brokenRow.ok && brokenRow.reason === 'db') expect(brokenRow.error).toBeInstanceOf(Error);
  });
});

describe('deleteDishFavorite (V-10)', () => {
  it('V-10 deleteDishFavorite は id と user_id で delete し、returning が 0 行なら deleted: false', async () => {
    const deleted = scriptedOf({ data: [{ id: FAVORITE_ID }] });
    expect(await deleteDishFavorite(dbOf(deleted), USER_ID, FAVORITE_ID)).toEqual({ ok: true, deleted: true });
    expect(deleted.queries[0].table).toBe(DISH_FAVORITES_TABLE);
    expect(deleted.queries[0].calls).toEqual([
      { method: 'delete', args: [] },
      { method: 'eq', args: ['id', FAVORITE_ID] },
      { method: 'eq', args: ['user_id', USER_ID] },
      { method: 'select', args: ['id'] },
    ]);

    expect(await deleteDishFavorite(dbOf(scriptedOf({ data: [] })), USER_ID, FAVORITE_ID)).toEqual({ ok: true, deleted: false });
    expect(await deleteDishFavorite(dbOf(scriptedOf({ data: null })), USER_ID, FAVORITE_ID)).toEqual({ ok: true, deleted: false });

    const dbError = { code: '42501', message: 'permission denied' };
    expect(await deleteDishFavorite(dbOf(scriptedOf({ error: dbError })), USER_ID, FAVORITE_ID)).toEqual({ ok: false, error: dbError });
  });
});

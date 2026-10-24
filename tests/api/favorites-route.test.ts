/**
 * tests/api/favorites-route.test.ts
 *
 * GET / POST /api/favorites (src/app/api/favorites/route.ts) の単体テスト。
 * 献立の料理のお気に入り (dish_favorites。#2011・docs/design/cross/22-dish-favorites.md §7.5.1・§12 の G-1〜G-7・P-1〜P-10)。
 *
 * #1226: limit / offset が NaN・負値・巨大値に対して無防備だった問題の回帰の表 (G-2・G-3) はそのまま残す。
 * 以前は `limit = Math.min(Number(get('limit') ?? '100'), 200)` / `offset = Number(get('offset') ?? '0')` で、
 * 上限しか見ておらず offset は無加工だったため、NaN・負の値・桁あふれする値が .range() に渡って空の一覧や 500 になっていた。
 *   - limit  : 1〜200、未指定・数字でない値は 100
 *   - offset : 0〜100000、未指定・数字でない値は 0
 * 件数より先の offset (PostgREST の 416) の扱いは src/modules/dish-favorites/server.ts の listDishFavorites が持つ
 * (tests/dish-favorites-server.test.ts の V-3)。
 *
 * G-2・G-3 は select / eq / ilike / order が自分を返し range が結果を返す偽物 (setupFavoritesQuery) で range の引数を見る。
 * ほかは tests/helpers/scripted-supabase.ts の偽物 (from を呼んだ順に結果を返し、呼び出しを記録する) に切り替える。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { NULL_CHARACTER_ERROR_CODE, NULL_CHARACTER_ERROR_MESSAGE } from '@/lib/api/null-character';
import {
  DISH_FAVORITE_DISH_MAX_BYTES,
  DISH_FAVORITE_INGREDIENT_MAX_CHARS,
  DISH_FAVORITE_INGREDIENTS_MAX_ITEMS,
  DISH_FAVORITE_INVALID_MESSAGE,
  DISH_FAVORITE_MARKDOWN_MAX_CHARS,
  DISH_FAVORITE_NAME_MAX_CHARS,
  DISH_FAVORITE_VALIDATION_CODE,
  DISH_FAVORITES_LIMIT_CODE,
  DISH_FAVORITES_QUERY_MAX_CHARS,
  DishSnapshotSchema,
  SaveDishFavoriteBodySchema,
  dishFavoritesLimitMessage,
  dishJsonByteLength,
  toDishFavorite,
  type DishFavoriteRow,
} from '@/modules/dish-favorites/core';
import { createScriptedSupabase, type ScriptedResult, type ScriptedSupabase } from '../helpers/scripted-supabase';

// ── モック (vi.hoisted: vi.mock のファクトリから参照するため) ────────────────────
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  userWarn: vi.fn(),
  userError: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  }),
}));

// 構造化ログ: 本物は app_logs テーブルへ書きに行くので、テストでは差し替える
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    withUser: () => ({
      debug: () => {},
      info: () => {},
      warn: mocks.userWarn,
      error: mocks.userError,
    }),
  }),
  generateRequestId: () => 'req_test',
}));

import { GET, POST } from '../../src/app/api/favorites/route';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FAVORITE_ID = '22222222-2222-4222-8222-222222222222';
const PLANNED_MEAL_ID = '44444444-4444-4444-8444-444444444444';

type QueryResult = {
  data: unknown[] | null;
  error: { code?: string; message: string } | null;
  count: number | null;
  status: number;
};

const OK_EMPTY: QueryResult = { data: [], error: null, count: 0, status: 200 };

/**
 * 一覧の問い合わせのビルダーの偽物 (G-2・G-3 のクランプの表)。
 * select / eq / ilike / order は自分自身を返し、最後の range だけが結果を返す。
 */
function setupFavoritesQuery(...results: QueryResult[]) {
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    ilike: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.ilike.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);

  const queue = results.length > 0 ? results : [OK_EMPTY];
  let call = 0;
  builder.range.mockImplementation(async () => queue[Math.min(call++, queue.length - 1)]);

  mocks.from.mockReturnValue(builder);
  return builder;
}

/** from を scripted-supabase の偽物に切り替える */
function useScripted(...results: ScriptedResult[]): ScriptedSupabase {
  const scripted = createScriptedSupabase(results);
  mocks.from.mockImplementation(scripted.db.from);
  return scripted;
}

async function callGet(queryString = '') {
  const res = await GET(new Request(`http://localhost/api/favorites${queryString}`));
  return { res, json: await res.json() };
}

async function callPost(body: string) {
  const res = await POST(
    new Request('http://localhost/api/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
  );
  return { res, json: await res.json() };
}

/** 1 回目の range(from, to) に渡された引数を取り出す */
function firstRangeArgs(builder: ReturnType<typeof setupFavoritesQuery>): [number, number] {
  expect(builder.range).toHaveBeenCalled();
  const [from, to] = builder.range.mock.calls[0] as [number, number];
  return [from, to];
}

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.from.mockReset();
  mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/favorites (G-1)', () => {
  it('G-1 未ログインは 401 で、DB には問い合わせない', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    setupFavoritesQuery();

    const { res, json } = await callGet('?limit=abc');

    expect(res.status).toBe(401);
    expect(json).toEqual({ error: API_UNAUTHENTICATED_MESSAGE });
    expect(mocks.from).not.toHaveBeenCalled();

    // getUser の失敗も同じ
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'jwt expired' } });
    const failed = await callGet();
    expect(failed.res.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe('G-2 limit は 1〜200 に丸め、未指定・数字でない値は 100 (#1226 の表をそのまま)', () => {
  it.each([
    ['未指定は既定値の 100', '', 100],
    ['Web・モバイルが送る 50 はそのまま通す', '?limit=50', 50],
    ['上限ちょうどの 200 はそのまま通す', '?limit=200', 200],
    ['上限を 1 超える 201 は 200 に丸める', '?limit=201', 200],
    ['99999 は 200 に丸める', '?limit=99999', 200],
    ['桁あふれするほど大きい値も 200 に丸める', '?limit=99999999999999999999', 200],
    ['指数表記の巨大な値も 200 に丸める', '?limit=1e9', 200],
    ['数字でない値 (abc) は既定値の 100 (以前は NaN が range に渡っていた)', '?limit=abc', 100],
    ['空文字は既定値の 100 (以前は 0 件を要求して空の一覧)', '?limit=', 100],
    ['NaN という文字列は既定値の 100', '?limit=NaN', 100],
    ['Infinity という文字列は既定値の 100', '?limit=Infinity', 100],
    ['-Infinity という文字列は既定値の 100', '?limit=-Infinity', 100],
    ['数字の後ろにゴミが付く値 (50abc) は既定値の 100', '?limit=50abc', 100],
    ['負の値 (-50) は下限の 1 (以前は不正な範囲で 500)', '?limit=-50', 1],
    ['0 は下限の 1 (以前は 0 件を要求して空の一覧)', '?limit=0', 1],
    ['小数は切り捨てる', '?limit=10.9', 10],
  ])('%s', async (_name, queryString, expectedLimit) => {
    const builder = setupFavoritesQuery();

    const { res } = await callGet(queryString);

    expect(res.status).toBe(200);
    // offset は 0 のままなので range は (0, limit - 1)。DB に要求する行数がここで決まる
    expect(firstRangeArgs(builder)).toEqual([0, expectedLimit - 1]);
  });
});

describe('G-3 offset は 0〜100000 に丸める (#1226 の表をそのまま)', () => {
  it.each([
    ['未指定は 0', '', 0],
    ['Web・モバイルが次のページで送る 50 はそのまま通す', '?offset=50', 50],
    ['上限ちょうどの 100000 はそのまま通す', '?offset=100000', 100000],
    ['上限を 1 超える 100001 は 100000 に丸める', '?offset=100001', 100000],
    ['桁あふれするほど大きい値も 100000 に丸める (以前は bigint の範囲外で 500)', '?offset=99999999999999999999', 100000],
    ['数字でない値 (abc) は 0 (以前は NaN が range に渡っていた)', '?offset=abc', 0],
    ['空文字は 0', '?offset=', 0],
    ['NaN という文字列は 0', '?offset=NaN', 0],
    ['Infinity という文字列は 0', '?offset=Infinity', 0],
    ['負の値 (-1) は 0 (以前は負の offset がそのまま range に渡っていた)', '?offset=-1', 0],
    ['大きな負の値も 0', '?offset=-99999999999999999999', 0],
    ['小数は切り捨てる', '?offset=2.9', 2],
  ])('%s', async (_name, queryString, expectedOffset) => {
    const builder = setupFavoritesQuery();

    const { res } = await callGet(queryString);

    expect(res.status).toBe(200);
    // limit は既定の 100 のままなので range は (offset, offset + 99)
    expect(firstRangeArgs(builder)).toEqual([expectedOffset, expectedOffset + 99]);
  });
});

describe('G-2・G-3 limit と offset の組み合わせ (#1226 の表をそのまま)', () => {
  it.each([
    // [説明, クエリ, 期待する range]
    ['どちらも正常な値 (limit=20, offset=40)', '?limit=20&offset=40', [40, 59]],
    ['どちらも不正でも既定値で動く (limit=abc, offset=-1)', '?limit=abc&offset=-1', [0, 99]],
    ['limit は負、offset は数字でない (limit=-5, offset=abc)', '?limit=-5&offset=abc', [0, 0]],
    ['どちらも巨大 (limit=99999, offset=99999999)', '?limit=99999&offset=99999999', [100000, 100199]],
    ['sort や q が付いていても丸める', '?limit=-1&offset=-1&sort=name&q=curry', [0, 0]],
  ] as Array<[string, string, [number, number]]>)('%s', async (_name, queryString, expectedRange) => {
    const builder = setupFavoritesQuery();

    const { res } = await callGet(queryString);

    expect(res.status).toBe(200);
    expect(firstRangeArgs(builder)).toEqual(expectedRange);
    // 不正な値をそのまま渡していない (NaN・負の値・Infinity を DB に送らない)
    for (const arg of firstRangeArgs(builder)) {
      expect(Number.isInteger(arg)).toBe(true);
      expect(arg).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('GET /api/favorites (G-4〜G-7)', () => {
  it('G-4 q は dish_name の部分一致、sort は newest / oldest / name、未知の sort は newest', async () => {
    const cases = [
      ['', ['created_at', { ascending: false }]],
      ['&sort=newest', ['created_at', { ascending: false }]],
      ['&sort=oldest', ['created_at', { ascending: true }]],
      ['&sort=name', ['dish_name_key', { ascending: true }]],
      ['&sort=bogus', ['created_at', { ascending: false }]],
    ] as const;

    for (const [sortParam, expectedOrder] of cases) {
      const scripted = useScripted({ data: [], count: 0 });

      const { res } = await callGet(`?q=%20%E3%81%98%E3%82%83%E3%81%8C%20${sortParam}`);

      expect(res.status, sortParam).toBe(200);
      expect(scripted.queries[0].table).toBe('dish_favorites');
      expect(scripted.queries[0].calls).toEqual([
        { method: 'select', args: [expect.any(String), { count: 'exact' }] },
        { method: 'eq', args: ['user_id', USER_ID] },
        // 前後の空白を除いた語で部分一致
        { method: 'ilike', args: ['dish_name', '%じゃが%'] },
        { method: 'order', args: [...expectedOrder] },
        { method: 'order', args: ['id', { ascending: true }] },
        { method: 'range', args: [0, 99] },
      ]);
    }

    // q が無い・空白だけなら絞らない
    const scripted = useScripted({ data: [], count: 0 });
    await callGet('?q=%20%20');
    expect(scripted.queries[0].calls.some((call) => call.method === 'ilike')).toBe(false);
  });

  it('G-7 q の NULL 文字を除き 100 文字で切ってから ilike に渡す (200。DB に NULL 文字が渡らない)', async () => {
    const longName = `肉じゃが${'あ'.repeat(DISH_FAVORITES_QUERY_MAX_CHARS + 20)}`;
    const raw = `  肉\u0000じゃが${'あ'.repeat(DISH_FAVORITES_QUERY_MAX_CHARS + 20)}`;
    const scripted = useScripted({ data: [], count: 0 });

    const { res, json } = await callGet(`?${new URLSearchParams({ q: raw }).toString()}`);

    expect(res.status).toBe(200);
    expect(json).toEqual({ favorites: [], total: 0 });
    const ilike = scripted.queries[0].calls.find((call) => call.method === 'ilike');
    expect(ilike).toEqual({ method: 'ilike', args: ['dish_name', `%${longName.slice(0, DISH_FAVORITES_QUERY_MAX_CHARS)}%`] });
    expect(DISH_FAVORITES_QUERY_MAX_CHARS).toBe(100);
    expect(JSON.stringify(scripted.queries)).not.toContain('\\u0000');
  });

  it('G-5 自分の dish_favorites を DishFavorite の形で返し total を添える (user_id・dish_name_key は本文に出ない)', async () => {
    const second = rowOf({
      id: '33333333-3333-4333-8333-333333333333',
      dish_name: 'カレー',
      dish_name_key: 'カレー',
      dish: DishSnapshotSchema.parse({ name: 'カレー', ingredients: [{ name: '玉ねぎ', amount_g: 100, note: null }] }),
      source_planned_meal_id: PLANNED_MEAL_ID,
    });
    const scripted = useScripted({ data: [rowOf(), second], count: 7, status: 206 });

    const { res, json } = await callGet('?limit=2&offset=0');

    expect(res.status).toBe(200);
    expect(mocks.from).toHaveBeenCalledWith('dish_favorites');
    expect(scripted.queries[0].calls).toContainEqual({ method: 'eq', args: ['user_id', USER_ID] });
    expect(scripted.queries[0].calls).toContainEqual({ method: 'range', args: [0, 1] });
    expect(json).toEqual({ favorites: [toDishFavorite(rowOf()), toDishFavorite(second)], total: 7 });
    for (const favorite of json.favorites as Array<Record<string, unknown>>) {
      expect(Object.keys(favorite).sort()).toEqual(['created_at', 'dish', 'dish_name', 'id', 'source_planned_meal_id', 'updated_at']);
    }
  });

  it('G-6 DB の失敗は 500 で、生のエラー文を本文に出さない (#1172)', async () => {
    useScripted({ error: { code: '42501', message: 'permission denied for table dish_favorites' }, status: 403 });

    const { res, json } = await callGet();

    expect(res.status).toBe(500);
    expect(json).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE });
    expect(JSON.stringify(json)).not.toContain('permission denied');
    // 元のエラー (テーブル名入りの生の文) は、構造化ログにだけ残る
    expect(mocks.userError).toHaveBeenCalledTimes(1);
    expect(mocks.userError.mock.calls[0][1]).toBeInstanceOf(Error);
    expect((mocks.userError.mock.calls[0][1] as Error).message).toBe('permission denied for table dish_favorites');

    // 行の形が正典と違うときも 500 (0 件の 200 にしない)
    mocks.userError.mockClear();
    useScripted({ data: [{ ...rowOf(), id: 'not-a-uuid' }], count: 1 });
    const broken = await callGet();
    expect(broken.res.status).toBe(500);
    expect(broken.json).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE });
    expect(mocks.userError).toHaveBeenCalledTimes(1);
  });
});

/** 写しの JSON のバイト数がちょうど bytes になる本文を作る (markdown 2 本に日本語 (3 バイト) と英字 (1 バイト) を詰める) */
function bodyWithDishBytes(bytes: number) {
  const UTF8_BYTES_PER_KANA = 3;
  const baseDish = { name: '肉じゃが', ingredients_md: '', recipe_steps_md: '' };
  const base = dishJsonByteLength(SaveDishFavoriteBodySchema.parse({ dish: baseDish }).dish);
  let rest = bytes - base;
  const kanaInIngredients = Math.min(DISH_FAVORITE_MARKDOWN_MAX_CHARS, Math.floor(rest / UTF8_BYTES_PER_KANA));
  rest -= kanaInIngredients * UTF8_BYTES_PER_KANA;
  const kanaInSteps = Math.floor(rest / UTF8_BYTES_PER_KANA);
  const asciiInSteps = rest - kanaInSteps * UTF8_BYTES_PER_KANA;
  const dish = {
    ...baseDish,
    ingredients_md: 'あ'.repeat(kanaInIngredients),
    recipe_steps_md: 'い'.repeat(kanaInSteps) + 'a'.repeat(asciiInSteps),
  };
  const parsed = SaveDishFavoriteBodySchema.parse({ dish });
  expect(dishJsonByteLength(parsed.dish)).toBe(bytes);
  return { dish };
}

describe('POST /api/favorites (P-1〜P-10)', () => {
  const validBody = { dish: { name: '肉じゃが' }, source_planned_meal_id: PLANNED_MEAL_ID };

  it('P-1 POST は NULL 文字の本文を認証の前に 400 INVALID_CHARACTER にする', async () => {
    const { res, json } = await callPost(JSON.stringify({ dish: { name: '肉\u0000じゃが' } }));

    expect(res.status).toBe(400);
    expect(json).toEqual({ error: NULL_CHARACTER_ERROR_MESSAGE, code: NULL_CHARACTER_ERROR_CODE });
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('P-2 POST は未ログインを 401', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    const { res, json } = await callPost(JSON.stringify(validBody));

    expect(res.status).toBe(401);
    expect(json).toEqual({ error: API_UNAUTHENTICATED_MESSAGE });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('P-3 POST は壊れた JSON を 400 (リクエストボディが不正です)', async () => {
    const { res, json } = await callPost('{"dish":');

    expect(res.status).toBe(400);
    expect(json).toEqual({ error: API_INVALID_JSON_MESSAGE });
    expect(API_INVALID_JSON_MESSAGE).toBe('リクエストボディが不正です');
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('P-4 POST は正典の形でない本文 (名前が空・鍵が 101 文字以上になる名前・材料 51 件・材料 1 行 2001 文字・構造の形の材料の name が空・負の栄養) を 400 VALIDATION_ERROR で、DB に問い合わせない', async () => {
    // 「㌀」(U+3300) は NFKC で「アパート」の 4 文字になる。30 文字の表示名の鍵は 120 文字
    const KEY_EXPANDING_CHAR = '㌀';
    const KEY_EXPANDING_COUNT = 30;
    const invalidBodies: Array<[string, unknown]> = [
      ['名前が空', { dish: { name: '' } }],
      ['名前が空白だけ', { dish: { name: '　 ' } }],
      ['名前が 101 文字', { dish: { name: 'あ'.repeat(DISH_FAVORITE_NAME_MAX_CHARS + 1) } }],
      ['鍵が 101 文字以上になる名前', { dish: { name: KEY_EXPANDING_CHAR.repeat(KEY_EXPANDING_COUNT) } }],
      ['材料 51 件', { dish: { name: '肉じゃが', ingredients: Array.from({ length: DISH_FAVORITE_INGREDIENTS_MAX_ITEMS + 1 }, () => 'じゃがいも') } }],
      ['材料 1 行 2001 文字', { dish: { name: '肉じゃが', ingredients: ['あ'.repeat(DISH_FAVORITE_INGREDIENT_MAX_CHARS + 1)] } }],
      ['構造の形の材料の name が空', { dish: { name: '肉じゃが', ingredients: [{ name: '', amount_g: 10, note: null }] } }],
      ['負の栄養', { dish: { name: '肉じゃが', protein_g: -1 } }],
      ['dish が無い', { source_planned_meal_id: PLANNED_MEAL_ID }],
      ['uuid でない source', { dish: { name: '肉じゃが' }, source_planned_meal_id: 'meal-1' }],
    ];

    for (const [label, body] of invalidBodies) {
      const { res, json } = await callPost(JSON.stringify(body));

      expect(res.status, label).toBe(400);
      expect(json, label).toEqual({ error: DISH_FAVORITE_INVALID_MESSAGE, code: DISH_FAVORITE_VALIDATION_CODE });
    }
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('P-10 POST は構造の形の材料と 677 文字の 1 行の材料をそのまま upsert に渡して 201 を返す (材料を落とさない)', async () => {
    const LONG_INGREDIENT_LINE_CHARS = 677;
    const longLine = '材'.repeat(LONG_INGREDIENT_LINE_CHARS);
    const ingredients = [{ name: '鶏むね肉', amount_g: 200, note: '皮なし' }, { name: '塩', amount_g: null, note: null }, longLine];
    const scripted = useScripted({ data: null }, { count: 0 }, { data: rowOf() });

    const { res } = await callPost(JSON.stringify({ dish: { name: '肉じゃが', ingredients } }));

    expect(res.status).toBe(201);
    const upsert = scripted.queries[2].calls[0];
    expect(upsert.method).toBe('upsert');
    const payload = upsert.args[0] as { dish: { ingredients: unknown[] } };
    expect(payload.dish.ingredients).toEqual(ingredients);
    expect((payload.dish.ingredients[2] as string).length).toBe(LONG_INGREDIENT_LINE_CHARS);
  });

  it('P-5 POST は写しが 32768 バイトを超えると 400 VALIDATION_ERROR で、DB に問い合わせない (from を呼ばない)', async () => {
    expect(DISH_FAVORITE_DISH_MAX_BYTES).toBe(32768);

    const over = bodyWithDishBytes(DISH_FAVORITE_DISH_MAX_BYTES + 1);
    // Zod の形としては正しい (文字数の上限の中) が、バイト数で断る
    expect(SaveDishFavoriteBodySchema.safeParse(over).success).toBe(true);
    const rejected = await callPost(JSON.stringify(over));
    expect(rejected.res.status).toBe(400);
    expect(rejected.json).toEqual({ error: DISH_FAVORITE_INVALID_MESSAGE, code: DISH_FAVORITE_VALIDATION_CODE });
    expect(mocks.from).not.toHaveBeenCalled();

    // ちょうど 32768 バイトは通す (境界)
    useScripted({ data: null }, { count: 0 }, { data: rowOf() });
    const accepted = await callPost(JSON.stringify(bodyWithDishBytes(DISH_FAVORITE_DISH_MAX_BYTES)));
    expect(accepted.res.status).toBe(201);
  });

  it('P-6 POST は新しい名前 (確認で行なし) を 201 { favorite, created: true } で返す', async () => {
    const saved = rowOf({ source_planned_meal_id: PLANNED_MEAL_ID });
    const scripted = useScripted({ data: null }, { count: 3 }, { data: saved });

    const { res, json } = await callPost(JSON.stringify({ dish: { name: '  肉じゃが ' }, source_planned_meal_id: PLANNED_MEAL_ID }));

    expect(res.status).toBe(201);
    expect(json).toEqual({ favorite: toDishFavorite(saved), created: true });
    expect(json.favorite).not.toHaveProperty('user_id');
    expect(json.favorite).not.toHaveProperty('dish_name_key');
    expect(scripted.queries.map((q) => q.table)).toEqual(['dish_favorites', 'dish_favorites', 'dish_favorites']);
    expect(scripted.queries[2].calls[0]).toEqual({
      method: 'upsert',
      args: [
        {
          user_id: USER_ID,
          dish_name: '肉じゃが',
          dish_name_key: '肉じゃが',
          dish: SaveDishFavoriteBodySchema.parse({ dish: { name: '肉じゃが' } }).dish,
          source_planned_meal_id: PLANNED_MEAL_ID,
        },
        { onConflict: 'user_id,dish_name_key' },
      ],
    });
  });

  it('P-7 POST は保存済みの名前 (確認で行あり) を件数を数えずに 200 { favorite, created: false } で返す', async () => {
    const scripted = useScripted({ data: { id: FAVORITE_ID } }, { data: rowOf() });

    const { res, json } = await callPost(JSON.stringify({ dish: { name: '肉じゃが' } }));

    expect(res.status).toBe(200);
    expect(json).toEqual({ favorite: toDishFavorite(rowOf()), created: false });
    expect(scripted.queries).toHaveLength(2);
    expect(scripted.queries[1].calls[0].method).toBe('upsert');
    // source_planned_meal_id を省いた本文は null で保存する
    expect((scripted.queries[1].calls[0].args[0] as { source_planned_meal_id: unknown }).source_planned_meal_id).toBeNull();
  });

  it('P-8 POST は上限で 409 CONFLICT_DISH_FAVORITES_LIMIT と件数入りの文を返す (DISH_FAVORITES_MAX_PER_USER を立てた値で)', async () => {
    const LIMIT_FROM_ENV = 5;
    vi.stubEnv('DISH_FAVORITES_MAX_PER_USER', String(LIMIT_FROM_ENV));
    const scripted = useScripted({ data: null }, { count: LIMIT_FROM_ENV });

    const { res, json } = await callPost(JSON.stringify(validBody));

    expect(res.status).toBe(409);
    expect(json).toEqual({ error: dishFavoritesLimitMessage(LIMIT_FROM_ENV), code: DISH_FAVORITES_LIMIT_CODE });
    expect(json.code).toBe('CONFLICT_DISH_FAVORITES_LIMIT');
    expect(json.error).toContain(`(${LIMIT_FROM_ENV} 件)`);
    // upsert しない
    expect(scripted.queries).toHaveLength(2);

    // 上限より 1 少なければ保存する
    useScripted({ data: null }, { count: LIMIT_FROM_ENV - 1 }, { data: rowOf() });
    expect((await callPost(JSON.stringify(validBody))).res.status).toBe(201);
  });

  it('P-9 POST は DB の失敗を 500 にする', async () => {
    const dbError = { code: '57014', message: 'canceling statement due to statement timeout on dish_favorites' };
    const scriptedFailures: ScriptedResult[][] = [
      [{ error: dbError }],
      [{ data: null }, { error: dbError }],
      [{ data: { id: FAVORITE_ID } }, { error: dbError }],
    ];

    for (const results of scriptedFailures) {
      mocks.userError.mockClear();
      useScripted(...results);

      const { res, json } = await callPost(JSON.stringify(validBody));

      expect(res.status).toBe(500);
      expect(json).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE });
      expect(JSON.stringify(json)).not.toContain('canceling statement');
      expect(mocks.userError).toHaveBeenCalledTimes(1);
    }
  });
});

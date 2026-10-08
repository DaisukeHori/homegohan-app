/**
 * tests/recipes-route.test.ts
 *
 * #1220: GET /api/recipes の page / limit / max_time に上限クランプが無く、
 * `?limit=100000` のような値で 1 リクエストが大量行を要求できた問題の回帰テスト。
 * 他の一覧 API と同じく clampIntParam (src/lib/http-params.ts) で丸めることを確認する。
 *
 * 期待する範囲 (src/app/api/recipes/route.ts):
 *   - limit    : 1〜100、未指定・数字でない値は 20
 *   - page     : 1〜1000、未指定・数字でない値は 1
 *   - max_time : 1〜1440 に丸めて .lte に渡す。未指定・空・数字でない値は絞り込まない
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));

const { GET } = await import('@/app/api/recipes/route');

const user = { id: 'user-1' };

type QueryResult = {
  data: unknown[] | null;
  error: { message: string } | null;
  count: number | null;
};

/**
 * recipes 一覧のクエリビルダーのモック。
 * select / or / eq / lte / order は自分自身を返し、最後の range だけが結果を返す。
 */
function setupRecipesQuery(
  result: QueryResult = { data: [], error: null, count: 0 },
) {
  const builder = {
    select: vi.fn(),
    or: vi.fn(),
    eq: vi.fn(),
    lte: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
  };
  builder.select.mockReturnValue(builder);
  builder.or.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.lte.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  builder.range.mockResolvedValue(result);
  mockFrom.mockReturnValue(builder);
  return builder;
}

async function callGet(queryString = '') {
  const res = await GET(new Request(`http://localhost/api/recipes${queryString}`));
  return { res, json: await res.json() };
}

/** range(from, to) に渡された引数を取り出す */
function rangeArgs(builder: ReturnType<typeof setupRecipesQuery>): [number, number] {
  expect(builder.range).toHaveBeenCalledTimes(1);
  const [from, to] = builder.range.mock.calls[0] as [number, number];
  return [from, to];
}

beforeEach(() => {
  vi.clearAllMocks();
  // 既定は未認証 (公開レシピのみ)
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/recipes: limit のクランプ (#1220)', () => {
  it.each([
    ['未指定は既定値の 20', '', 20],
    ['モバイルが固定で送る 30 はそのまま通す', '?limit=30', 30],
    ['上限ちょうどの 100 はそのまま通す', '?limit=100', 100],
    ['上限を 1 超える 101 は 100 に丸める', '?limit=101', 100],
    ['100000 は 100 に丸める (本件の再現)', '?limit=100000', 100],
    ['桁あふれするほど大きい値も 100 に丸める', '?limit=99999999999999999999', 100],
    ['指数表記の巨大な値も 100 に丸める', '?limit=1e9', 100],
    ['数字でない値は既定値の 20', '?limit=abc', 20],
    ['空文字は既定値の 20', '?limit=', 20],
    ['NaN という文字列は既定値の 20', '?limit=NaN', 20],
    ['Infinity という文字列は既定値の 20', '?limit=Infinity', 20],
    ['負の値は下限の 1', '?limit=-5', 1],
    ['0 は下限の 1', '?limit=0', 1],
    ['小数は切り捨てる', '?limit=10.9', 10],
  ])('%s', async (_name, queryString, expectedLimit) => {
    const builder = setupRecipesQuery();

    const { res, json } = await callGet(queryString);

    expect(res.status).toBe(200);
    // 1 ページ目なので range は (0, limit - 1)。DB に要求する行数がここで決まる
    expect(rangeArgs(builder)).toEqual([0, expectedLimit - 1]);
    expect(json.pagination.limit).toBe(expectedLimit);
  });

  it('limit=0 でも totalPages が無限大 (JSON では null) にならない', async () => {
    setupRecipesQuery({ data: [], error: null, count: 5 });

    const { json } = await callGet('?limit=0');

    // 下限の 1 に丸まるので 5 件 / 1 件 = 5 ページ
    expect(json.pagination.limit).toBe(1);
    expect(json.pagination.totalPages).toBe(5);
  });

  it('limit が数字でないときも totalPages は既定の limit (20) で計算する', async () => {
    setupRecipesQuery({ data: [], error: null, count: 45 });

    const { json } = await callGet('?limit=abc');

    expect(json.pagination.limit).toBe(20);
    expect(json.pagination.totalPages).toBe(3);
  });
});

describe('GET /api/recipes: page のクランプ (#1220)', () => {
  it.each([
    // [説明, クエリ, 期待する range]
    ['未指定は 1 ページ目', '', [0, 19]],
    ['page=1 は 1 ページ目', '?page=1', [0, 19]],
    ['page=3 は offset 40', '?page=3', [40, 59]],
    ['page と limit の組み合わせ (page=3, limit=10)', '?page=3&limit=10', [20, 29]],
    ['数字でない値は 1 ページ目', '?page=abc', [0, 19]],
    ['空文字は 1 ページ目', '?page=', [0, 19]],
    ['0 は 1 ページ目', '?page=0', [0, 19]],
    ['負の値は 1 ページ目', '?page=-3', [0, 19]],
    ['小数は切り捨てる (2.7 は 2 ページ目)', '?page=2.7', [20, 39]],
    ['上限ちょうどの 1000 ページ目はそのまま通す', '?page=1000', [19980, 19999]],
    ['1001 は 1000 ページ目に丸める', '?page=1001', [19980, 19999]],
    ['巨大な値は 1000 ページ目に丸める', '?page=999999999999', [19980, 19999]],
  ] as Array<[string, string, [number, number]]>)(
    '%s',
    async (_name, queryString, expectedRange) => {
      const builder = setupRecipesQuery();

      const { res } = await callGet(queryString);

      expect(res.status).toBe(200);
      expect(rangeArgs(builder)).toEqual(expectedRange);
    },
  );

  it('レスポンスの pagination.page には丸めた後の値が入る', async () => {
    setupRecipesQuery();

    const { json: huge } = await callGet('?page=999999999999');
    expect(huge.pagination.page).toBe(1000);

    const { json: nan } = await callGet('?page=abc');
    expect(nan.pagination.page).toBe(1);
  });

  it('page と limit の両方が巨大でも、1 リクエストで要求する行数は 100 以内・offset は 99900 以内', async () => {
    const builder = setupRecipesQuery();

    const { res, json } = await callGet('?page=999999999&limit=100000');
    const [from, to] = rangeArgs(builder);

    expect(res.status).toBe(200);
    expect(to - from + 1).toBeLessThanOrEqual(100);
    expect(from).toBeLessThanOrEqual(99900);
    expect(json.pagination).toMatchObject({ page: 1000, limit: 100 });
  });
});

describe('GET /api/recipes: max_time の検証 (#1220)', () => {
  it.each([
    ['未指定', ''],
    ['空文字', '?max_time='],
    ['空白だけ', '?max_time=%20%20'],
    ['数字でない値', '?max_time=abc'],
    ['NaN という文字列', '?max_time=NaN'],
    ['Infinity という文字列', '?max_time=Infinity'],
  ])('%s のときは絞り込まない (.lte を呼ばない)', async (_name, queryString) => {
    const builder = setupRecipesQuery();

    const { res } = await callGet(queryString);

    expect(res.status).toBe(200);
    expect(builder.lte).not.toHaveBeenCalled();
  });

  it.each([
    ['モバイルが送る 30 はそのまま渡す', '?max_time=30', 30],
    ['上限ちょうどの 1440 はそのまま渡す', '?max_time=1440', 1440],
    ['1441 は 1440 に丸める', '?max_time=1441', 1440],
    ['int の範囲を超える巨大な値は 1440 に丸める', '?max_time=99999999999', 1440],
    ['0 は下限の 1', '?max_time=0', 1],
    ['負の値は下限の 1', '?max_time=-5', 1],
    ['小数は切り捨てる', '?max_time=45.9', 45],
  ])('%s', async (_name, queryString, expectedMaxTime) => {
    const builder = setupRecipesQuery();

    const { res } = await callGet(queryString);

    expect(res.status).toBe(200);
    expect(builder.lte).toHaveBeenCalledTimes(1);
    expect(builder.lte).toHaveBeenCalledWith('cooking_time_minutes', expectedMaxTime);
  });
});

describe('GET /api/recipes: クランプ以外の挙動は変えない', () => {
  it('未認証なら公開レシピだけを created_at の新しい順で取る', async () => {
    const builder = setupRecipesQuery();

    await callGet();

    expect(mockFrom).toHaveBeenCalledWith('recipes');
    expect(builder.select).toHaveBeenCalledWith('*', { count: 'exact' });
    expect(builder.eq).toHaveBeenCalledWith('is_public', true);
    expect(builder.or).not.toHaveBeenCalled();
    expect(builder.order).toHaveBeenCalledWith('created_at', { ascending: false });
  });

  it('認証済みなら公開レシピと自分のレシピを取り、いいね情報も一緒に取る', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });
    const builder = setupRecipesQuery();

    await callGet();

    expect(builder.select).toHaveBeenCalledWith(
      '*, user_profiles(nickname), recipe_likes(user_id)',
      { count: 'exact' },
    );
    expect(builder.or).toHaveBeenCalledWith('is_public.eq.true,user_id.eq.user-1');
  });

  it('category / cuisine_type / difficulty はそのまま eq で絞り込む', async () => {
    const builder = setupRecipesQuery();

    await callGet('?category=main&cuisine_type=japanese&difficulty=easy');

    expect(builder.eq).toHaveBeenCalledWith('category', 'main');
    expect(builder.eq).toHaveBeenCalledWith('cuisine_type', 'japanese');
    expect(builder.eq).toHaveBeenCalledWith('difficulty', 'easy');
  });

  it('DB エラーのときは従来どおり空の 200 を返し、pagination には丸めた値を入れる', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    setupRecipesQuery({ data: null, error: { message: 'boom' }, count: null });

    const { res, json } = await callGet('?page=abc&limit=100000');

    expect(res.status).toBe(200);
    expect(json).toEqual({
      recipes: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
    });
    expect(consoleError).toHaveBeenCalled();
  });

  it('取得した行を camelCase に変換し、自分のいいねを isLiked に反映する', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });
    setupRecipesQuery({
      data: [
        {
          id: 'r1',
          user_id: 'user-2',
          user_profiles: { nickname: 'ほり' },
          name: '肉じゃが',
          description: '定番',
          calories_kcal: 320,
          cooking_time_minutes: 30,
          servings: 2,
          image_url: null,
          ingredients: [],
          steps: [],
          is_public: true,
          category: 'main',
          cuisine_type: 'japanese',
          difficulty: 'easy',
          tags: null,
          nutrition: null,
          tips: null,
          video_url: null,
          view_count: null,
          like_count: 3,
          recipe_likes: [{ user_id: 'user-1' }],
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ],
      error: null,
      count: 1,
    });

    const { json } = await callGet('?limit=30');

    expect(json.pagination).toEqual({ page: 1, limit: 30, total: 1, totalPages: 1 });
    expect(json.recipes).toHaveLength(1);
    expect(json.recipes[0]).toMatchObject({
      id: 'r1',
      userId: 'user-2',
      authorName: 'ほり',
      name: '肉じゃが',
      cookingTimeMinutes: 30,
      tags: [],
      viewCount: 0,
      likeCount: 3,
      isLiked: true,
    });
  });
});

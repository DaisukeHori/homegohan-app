/**
 * tests/api/favorites-route.test.ts
 *
 * #1226: GET /api/favorites の limit / offset が NaN・負値・巨大値に対して無防備だった問題の回帰テスト。
 *
 * 以前は `limit = Math.min(Number(get('limit') ?? '100'), 200)` / `offset = Number(get('offset') ?? '0')` で、
 * 上限しか見ておらず offset は無加工だったため (ローカルの Supabase で確認した挙動)、
 *   - ?limit=abc / ?offset=abc : NaN が .range() に渡り、何も返らない空の一覧になる
 *   - ?limit= (空) / ?limit=0  : 0 件を要求して空の一覧になる
 *   - ?limit=-50               : 終わりが始まりより前の範囲が PostgREST に渡り、エラー → 生のメッセージ付きの 500
 *   - ?offset=99999999999999999999 : bigint の範囲外でエラー → 500
 *   - ?offset=100000 (件数より先)   : PostgREST が 416 を返し、エラー → 500
 * になっていた。他の一覧 API と同じく clampIntParam (src/lib/http-params.ts) で丸めることを確認する。
 *
 * 期待する範囲 (src/app/api/favorites/route.ts):
 *   - limit  : 1〜200、未指定・数字でない値は 100
 *   - offset : 0〜100000、未指定・数字でない値は 0
 *   - offset が件数より先 (PostgREST が 416 を返す) ときも 500 にせず、空のページと本当の total を返す
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { GET } from '../../src/app/api/favorites/route';

const USER_ID = 'user-1';

type QueryResult = {
  data: unknown[] | null;
  error: { code?: string; message: string } | null;
  count: number | null;
  status: number;
};

const OK_EMPTY: QueryResult = { data: [], error: null, count: 0, status: 200 };

/**
 * recipe_likes の一覧クエリのビルダーのモック。
 * select / eq / ilike / order は自分自身を返し、最後の range だけが結果を返す。
 * results を渡した順に 1 回目・2 回目…の range が返す。呼び出しが results より多いときは最後の結果を返し続ける。
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

async function callGet(queryString = '') {
  const res = await GET(new Request(`http://localhost/api/favorites${queryString}`));
  return { res, json: await res.json() };
}

/** 1 回目の range(from, to) に渡された引数を取り出す */
function firstRangeArgs(builder: ReturnType<typeof setupFavoritesQuery>): [number, number] {
  expect(builder.range).toHaveBeenCalled();
  const [from, to] = builder.range.mock.calls[0] as [number, number];
  return [from, to];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
});

describe('GET /api/favorites: limit のクランプ (#1226)', () => {
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

describe('GET /api/favorites: offset のクランプ (#1226)', () => {
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

describe('GET /api/favorites: limit と offset の組み合わせ (#1226)', () => {
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

describe('GET /api/favorites: 件数より先の offset (416)', () => {
  // offset が件数より先だと PostgREST は 416 (Range Not Satisfiable) を返す。
  // 本文は標準的な JSON のときも、壊れていて code が取れないとき (ローカルの PostgREST) もある。
  it.each([
    [
      'PostgREST 標準のエラー本文 (code あり)',
      { code: 'PGRST103', message: 'Requested range not satisfiable' },
    ],
    ['壊れた本文 (code なし)', { message: '{"' }],
  ])('%s でも 500 にせず、空のページと本当の total を返す', async (_name, error) => {
    const builder = setupFavoritesQuery(
      { data: null, error, count: null, status: 416 },
      // 件数を取り直すための 2 回目の問い合わせ。返ってきた 1 件は total を知るためだけに使い、一覧には載せない
      {
        data: [{ id: 'like-1', recipe_id: '肉じゃが', recipe_uuid: null, created_at: '2026-01-01T00:00:00Z' }],
        error: null,
        count: 3,
        status: 206,
      },
    );

    const { res, json } = await callGet('?offset=100000');

    expect(res.status).toBe(200);
    expect(json).toEqual({ favorites: [], total: 3 });
    // 1 回目は要求どおりの範囲、2 回目は件数だけ知りたいので先頭から 1 件
    expect(builder.range).toHaveBeenCalledTimes(2);
    expect(builder.range).toHaveBeenNthCalledWith(1, 100000, 100099);
    expect(builder.range).toHaveBeenNthCalledWith(2, 0, 0);
    expect(mocks.userError).not.toHaveBeenCalled();
  });

  it('絞り込み (q) と並び順 (sort) は件数の取り直しにも同じものを使う', async () => {
    const builder = setupFavoritesQuery(
      { data: null, error: { message: '{"' }, count: null, status: 416 },
      { data: [], error: null, count: 2, status: 206 },
    );

    const { res, json } = await callGet('?offset=500&q=curry&sort=name');

    expect(res.status).toBe(200);
    expect(json).toEqual({ favorites: [], total: 2 });
    // 1 回目・2 回目ともに q の ilike と name の並び順がかかっている
    expect(builder.ilike).toHaveBeenCalledTimes(2);
    expect(builder.ilike).toHaveBeenNthCalledWith(2, 'recipe_id', '%curry%');
    expect(builder.order).toHaveBeenNthCalledWith(2, 'recipe_id', { ascending: true });
  });

  it('件数の取り直しも失敗したら、これまでどおり 500 で返す', async () => {
    setupFavoritesQuery(
      { data: null, error: { message: '{"' }, count: null, status: 416 },
      { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' }, count: null, status: 500 },
    );

    const { res, json } = await callGet('?offset=100000');

    expect(res.status).toBe(500);
    expect(json).toHaveProperty('error');
    expect(mocks.userError).toHaveBeenCalledTimes(1);
  });

  it('416 以外のエラーは、これまでどおり 500 とメッセージを返す (件数の取り直しはしない)', async () => {
    const builder = setupFavoritesQuery({
      data: null,
      error: { code: '42501', message: 'permission denied for table recipe_likes' },
      count: null,
      status: 403,
    });

    const { res, json } = await callGet();

    expect(res.status).toBe(500);
    expect(json).toEqual({ error: 'permission denied for table recipe_likes' });
    expect(builder.range).toHaveBeenCalledTimes(1);
    expect(mocks.userError).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/favorites: 変えていない挙動', () => {
  it('未ログインは 401 で、DB には問い合わせない', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    setupFavoritesQuery();

    const { res, json } = await callGet('?limit=abc');

    expect(res.status).toBe(401);
    expect(json).toEqual({ error: 'Unauthorized' });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('自分のお気に入りだけを recipe_likes から引き、整形して total を添えて返す', async () => {
    const builder = setupFavoritesQuery({
      data: [
        { id: 'like-1', recipe_id: '肉じゃが', recipe_uuid: 'uuid-1', created_at: '2026-01-02T00:00:00Z' },
        { id: 'like-2', recipe_id: 'カレー', recipe_uuid: null, created_at: '2026-01-01T00:00:00Z' },
      ],
      error: null,
      count: 7,
      status: 200,
    });

    const { res, json } = await callGet('?limit=2&offset=0');

    expect(res.status).toBe(200);
    expect(mocks.from).toHaveBeenCalledWith('recipe_likes');
    expect(builder.eq).toHaveBeenCalledWith('user_id', USER_ID);
    expect(json).toEqual({
      favorites: [
        { id: 'like-1', recipeName: '肉じゃが', recipeUuid: 'uuid-1', likedAt: '2026-01-02T00:00:00Z' },
        { id: 'like-2', recipeName: 'カレー', recipeUuid: null, likedAt: '2026-01-01T00:00:00Z' },
      ],
      total: 7,
    });
  });

  it('q は recipe_id の部分一致、sort は並び順に使う (未知の sort は新しい順)', async () => {
    const builder = setupFavoritesQuery();

    await callGet('?q=%20curry%20&sort=oldest');
    expect(builder.ilike).toHaveBeenCalledWith('recipe_id', '%curry%');
    expect(builder.order).toHaveBeenCalledWith('created_at', { ascending: true });

    builder.order.mockClear();
    await callGet('?sort=bogus');
    expect(builder.order).toHaveBeenCalledWith('created_at', { ascending: false });
  });

  it('列が無いとき (42703) は列を絞って再試行する (#302)', async () => {
    const builder = setupFavoritesQuery(
      { data: null, error: { code: '42703', message: 'column recipe_likes.id does not exist' }, count: null, status: 400 },
      {
        data: [{ user_id: USER_ID, recipe_id: 'カレー', recipe_uuid: null, created_at: '2026-01-01T00:00:00Z' }],
        error: null,
        count: 1,
        status: 200,
      },
    );

    const { res, json } = await callGet();

    expect(res.status).toBe(200);
    expect(builder.select).toHaveBeenNthCalledWith(1, 'id, recipe_id, recipe_uuid, created_at', { count: 'exact' });
    expect(builder.select).toHaveBeenNthCalledWith(2, 'user_id, recipe_id, recipe_uuid, created_at', { count: 'exact' });
    expect(json.favorites).toEqual([
      { id: `${USER_ID}:カレー`, recipeName: 'カレー', recipeUuid: null, likedAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(json.total).toBe(1);
    expect(mocks.userWarn).toHaveBeenCalledTimes(1);
  });
});

/**
 * tests/health-blood-tests-route.test.ts
 *
 * #1329: GET /api/health/blood-tests は limit を `parseInt` で読んでいたため、
 * `?limit=abc` のような数字でない値が NaN のまま Math.min / Math.max を素通りし、
 * `.limit(NaN)` として DB に渡っていた問題の回帰テスト。
 * 他の /api/health/* 一覧 API と同じく clampIntParam (src/lib/http-params.ts) で丸めることを確認する。
 *
 * 期待する範囲 (src/app/api/health/blood-tests/route.ts):
 *   - limit : 1〜200、未指定・空・数字でない値は 10
 *
 * DB に渡る値 (= `.limit()` の引数) を直接見る。NaN は `expect(...).toBe(10)` で落ちるだけでなく、
 * 「必ず 1〜200 の整数」であることも別に確かめる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));

// GET では使わない (POST の AI レビュー用)。読み込んだだけで OpenAI SDK や Upstash を
// 初期化しないよう、軽いモックに差し替える。
vi.mock('@/lib/ai/fast-llm', () => ({
  getFastLLMClient: vi.fn(),
  getFastLLMModel: vi.fn(() => 'test-model'),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  rateLimitExceededResponse: vi.fn(),
}));

const { GET } = await import('@/app/api/health/blood-tests/route');

const user = { id: 'user-1' };

type QueryResult = {
  data: unknown[] | null;
  error: { message: string } | null;
};

/**
 * 一覧取得の 2 本のクエリのモック。
 *  - blood_test_results                 : select → eq → order → limit (limit が結果を返す)
 *  - blood_test_longitudinal_reviews    : select → eq → maybeSingle
 */
function setupQueries(
  options: { results?: QueryResult; review?: unknown } = {},
) {
  const results: QueryResult = options.results ?? { data: [], error: null };

  const resultsBuilder = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
  };
  resultsBuilder.select.mockReturnValue(resultsBuilder);
  resultsBuilder.eq.mockReturnValue(resultsBuilder);
  resultsBuilder.order.mockReturnValue(resultsBuilder);
  resultsBuilder.limit.mockResolvedValue(results);

  const reviewBuilder = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
  };
  reviewBuilder.select.mockReturnValue(reviewBuilder);
  reviewBuilder.eq.mockReturnValue(reviewBuilder);
  reviewBuilder.maybeSingle.mockResolvedValue({
    data: options.review ?? null,
    error: null,
  });

  mockFrom.mockImplementation((table: string) => {
    if (table === 'blood_test_results') return resultsBuilder;
    if (table === 'blood_test_longitudinal_reviews') return reviewBuilder;
    throw new Error(`unexpected table: ${table}`);
  });

  return { resultsBuilder, reviewBuilder };
}

async function callGet(queryString = '') {
  const res = await GET(
    new Request(`http://localhost/api/health/blood-tests${queryString}`) as NextRequest,
  );
  return { res, json: await res.json() };
}

/** DB (PostgREST) に渡された limit を取り出す */
function dbLimit(builder: ReturnType<typeof setupQueries>['resultsBuilder']): number {
  expect(builder.limit).toHaveBeenCalledTimes(1);
  return builder.limit.mock.calls[0][0] as number;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user }, error: null });
});

describe('GET /api/health/blood-tests: limit のクランプ (#1329)', () => {
  it.each([
    // 通常の値
    ['未指定は既定値の 10', '', 10],
    ['画面 (web / モバイル) が送る 20 はそのまま通す', '?limit=20', 20],
    ['下限ちょうどの 1 はそのまま通す', '?limit=1', 1],
    ['上限ちょうどの 200 はそのまま通す', '?limit=200', 200],

    // 数字でない値・空 → 既定値 (以前は NaN が DB に渡っていた)
    ['数字でない値は既定値の 10 (本件の再現)', '?limit=abc', 10],
    ['NaN という文字列は既定値の 10', '?limit=NaN', 10],
    ['空文字は既定値の 10', '?limit=', 10],
    ['空白だけは既定値の 10', '?limit=%20%20', 10],
    ['Infinity という文字列は既定値の 10', '?limit=Infinity', 10],
    ['-Infinity という文字列は既定値の 10', '?limit=-Infinity', 10],
    ['数字の後ろに文字が付く値は既定値の 10', '?limit=20abc', 10],
    ['数字の前に文字が付く値は既定値の 10', '?limit=abc20', 10],

    // 範囲外 → 端に丸める
    ['負の値は下限の 1', '?limit=-5', 1],
    ['0 は下限の 1', '?limit=0', 1],
    ['上限を 1 超える 201 は 200 に丸める', '?limit=201', 200],
    ['100000 は 200 に丸める', '?limit=100000', 200],
    ['桁あふれするほど大きい値も 200 に丸める', '?limit=99999999999999999999', 200],
    ['指数表記の巨大な値も 200 に丸める (parseInt だと 1 になっていた)', '?limit=1e9', 200],

    // 小数 → 切り捨てたうえで範囲に収める
    ['小数は切り捨てる (10.9 は 10)', '?limit=10.9', 10],
    ['1 未満の小数 0.5 は下限の 1', '?limit=0.5', 1],
    ['負の小数 -0.5 は下限の 1', '?limit=-0.5', 1],
    ['上限を超える小数 200.9 は 200', '?limit=200.9', 200],
    ['上限を大きく超える小数 1234.5 は 200', '?limit=1234.5', 200],
  ])('%s', async (_name, queryString, expectedLimit) => {
    const { resultsBuilder } = setupQueries();

    const { res } = await callGet(queryString);

    expect(res.status).toBe(200);
    expect(dbLimit(resultsBuilder)).toBe(expectedLimit);
  });

  // [説明, limit に入れる生の文字列]。テスト名が長くならないよう、説明は別に持つ。
  it.each([
    ['abc', 'abc'],
    ['NaN', 'NaN'],
    ['null', 'null'],
    ['undefined', 'undefined'],
    ['true', 'true'],
    ['[]', '[]'],
    ['{}', '{}'],
    ['空文字', ''],
    ['空白だけ', '   '],
    ['16 進数の 0x10', '0x10'],
    ['指数表記の 1e3', '1e3'],
    ['指数表記の 1e-3', '1e-3'],
    ['桁区切りの 1_000', '1_000'],
    ['符号が重なった --5', '--5'],
    ['後ろに符号が付いた 5-', '5-'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['アラビア数字', '٣'],
    ['全角数字', '１０'],
    ['Number() で Infinity になる桁数の正の値 (9 が 400 桁)', '9'.repeat(400)],
    ['Number() で -Infinity になる桁数の負の値 (9 が 400 桁)', '-' + '9'.repeat(400)],
    ['NUL 文字', '\u0000'],
    ['絵文字', '😀'],
  ])('どんな文字列でも DB に渡る limit は 1〜200 の整数になる (%s)', async (_name, raw) => {
    const { resultsBuilder } = setupQueries();

    const { res } = await callGet(`?limit=${encodeURIComponent(raw)}`);
    const limit = dbLimit(resultsBuilder);

    expect(res.status).toBe(200);
    expect(Number.isNaN(limit)).toBe(false);
    expect(Number.isInteger(limit)).toBe(true);
    expect(limit).toBeGreaterThanOrEqual(1);
    expect(limit).toBeLessThanOrEqual(200);
  });

  it('limit を複数付けても最初の 1 つだけを見て、NaN にならない', async () => {
    const { resultsBuilder } = setupQueries();

    const { res } = await callGet('?limit=abc&limit=50');

    expect(res.status).toBe(200);
    expect(dbLimit(resultsBuilder)).toBe(10);
  });
});

describe('GET /api/health/blood-tests: クランプ以外の挙動は変えない', () => {
  it('未認証なら 401 を返し、DB には触らない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    setupQueries();

    const { res, json } = await callGet('?limit=abc');

    expect(res.status).toBe(401);
    expect(json).toEqual({ error: 'Unauthorized' });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('自分の検査結果だけを、検査日の新しい順に取る', async () => {
    const { resultsBuilder } = setupQueries();

    await callGet('?limit=20');

    expect(mockFrom).toHaveBeenCalledWith('blood_test_results');
    expect(resultsBuilder.select).toHaveBeenCalledWith('*');
    expect(resultsBuilder.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(resultsBuilder.order).toHaveBeenCalledWith('test_date', { ascending: false });
  });

  it('検査結果と経年レビューを results / longitudinalReview で返す', async () => {
    const rows = [
      { id: 'bt-2', test_date: '2026-02-01', hba1c: 5.6 },
      { id: 'bt-1', test_date: '2026-01-01', hba1c: 5.8 },
    ];
    const review = { id: 'rv-1', user_id: 'user-1' };
    const { reviewBuilder } = setupQueries({
      results: { data: rows, error: null },
      review,
    });

    const { res, json } = await callGet('?limit=20');

    expect(res.status).toBe(200);
    expect(json).toEqual({ results: rows, longitudinalReview: review });
    expect(mockFrom).toHaveBeenCalledWith('blood_test_longitudinal_reviews');
    expect(reviewBuilder.eq).toHaveBeenCalledWith('user_id', 'user-1');
  });

  it('DB エラーのときは 500 とメッセージを返し、経年レビューは取りに行かない', async () => {
    setupQueries({ results: { data: null, error: { message: 'boom' } } });

    const { res, json } = await callGet('?limit=20');

    expect(res.status).toBe(500);
    expect(json).toEqual({ error: 'boom' });
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
});

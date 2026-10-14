/**
 * tests/api/ai-hint-route.test.ts
 *
 * #1327: POST /api/ai/hint (週間献立の統計モーダルにある「週間AIヒント」) の回帰テスト。
 *
 * 以前のルートは、週間献立ページを開くたびに Edge Function generate-hint (中で AI を呼ぶ) を呼んでいた。
 * しかしその戻り値は使わず、いつもルート内の定型ヒント (getDefaultHint) を返していた。
 * 生成結果の保存先 user_hints テーブルも本番に無く、AI を呼んで結果を捨てているだけで、費用の無駄だった。
 * さらに、写真解析などと共有する 'analysis' のレート制限 (10 回/分) まで、ページを開くたびに消費していた。
 *
 * 期待する挙動 (src/app/api/ai/hint/route.ts):
 *   - 未ログインは 401。
 *   - ログイン済みなら supabase.functions.invoke (= Edge Function) を一切呼ばず、
 *     { hint: 空でない文字列 } を 200 で返す。レスポンスの形は変えない (呼び出し元: menus/weekly/page.tsx)。
 *   - AI を呼ばないので、'analysis' のレート制限を消費しない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── モック (vi.hoisted: vi.mock のファクトリから参照するため) ────────────────────
const mocks = vi.hoisted(() => {
  // レート制限は Upstash ではなく in-memory で動かす (ネットワークへ出ない)。
  // rate-limit.ts は import 時に環境変数を読むので、import より前に消しておく
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  return {
    getUser: vi.fn(),
    invoke: vi.fn(),
  };
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    functions: { invoke: mocks.invoke },
  }),
}));

// 構造化ログ: 本物は app_logs テーブルへ書きに行くので、テストでは差し替える
// (rate-limit.ts が import 時に使う。ここで書き込みが起きないようにしておく)
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { checkRateLimit } from '@/lib/rate-limit';
import { POST } from '../../src/app/api/ai/hint/route';

const USER_ID = 'hint-user-1';
// レート制限の枠は user.id ごとに数える。ほかのテストの呼び出しと混ざらないよう専用のユーザーを使う
const RATE_LIMIT_USER_ID = 'hint-rate-limit-user';

/** 週間献立ページ (fetchAiHint) が送る本文と同じ形 */
const PAGE_BODY = {
  cookRate: 70,
  avgCal: 1800,
  cookCount: 10,
  buyCount: 3,
  outCount: 1,
  expiringItems: [] as string[],
};

function makeRequest(body: unknown = PAGE_BODY): Request {
  return new Request('http://localhost/api/ai/hint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
  // 以前のルートが呼んでいた Edge Function。呼ばれたことを検知できればよいので、成功を返しておく
  mocks.invoke.mockResolvedValue({ data: { hint: 'AI が作ったヒント' }, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/ai/hint: 認証 (#1327)', () => {
  it('未ログイン (user が無い) は 401 を返し、Edge Function を呼ばない', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('認証エラー (getUser が error を返す) も 401 を返し、Edge Function を呼ばない', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid JWT' } });

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe('POST /api/ai/hint: AI を呼ばずに定型のヒントを返す (#1327)', () => {
  it('ログイン済みなら 200 で { hint } (空でない文字列) を返し、Edge Function (functions.invoke) を呼ばない', async () => {
    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    const json = await res.json();
    // レスポンスの形は従来どおり { hint } だけ (呼び出し元の fetchAiHint が読むのは hint のみ)
    expect(Object.keys(json)).toEqual(['hint']);
    expect(typeof json.hint).toBe('string');
    expect(json.hint.trim().length).toBeGreaterThan(0);
    // 以前は、ここで generate-hint を呼んで AI の費用がかかっていた
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('リクエストの自炊率がヒントに反映される', async () => {
    // 自炊率 50%・カロリーは普通・期限間近の食材なし → ヒントの候補は自炊率のものだけ (乱数に左右されない)
    const res = await POST(makeRequest({ ...PAGE_BODY, cookRate: 50, avgCal: 2000, expiringItems: [] }));

    expect((await res.json()).hint).toContain('自炊率50%');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('リクエストの期限間近の食材 (先頭の 3 件まで) がヒントに反映される', async () => {
    // 候補は [自炊率のヒント, 期限間近のヒント] の 2 つ。乱数を最大にして後ろ (期限間近) を選ばせる
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    const res = await POST(
      makeRequest({ ...PAGE_BODY, cookRate: 85, expiringItems: ['牛乳', '卵', 'ほうれん草', '豆腐'] }),
    );

    const { hint } = await res.json();
    expect(hint).toContain('牛乳、卵、ほうれん草');
    expect(hint).not.toContain('豆腐');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('本文が JSON として読めなくても 200 と固定のヒントを返す (従来どおり)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(makeRequest('{this is not json'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hint: '今週も健康的な食事を心がけましょう！' });
    expect(errorSpy).toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("POST /api/ai/hint: 写真解析などと共有する 'analysis' のレート制限を消費しない (#1327)", () => {
  it("'analysis' の上限 (10 回/分) を超える回数を呼んでも 429 にならず、'analysis' の枠も減らない", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: RATE_LIMIT_USER_ID } }, error: null });

    // 週間献立ページを開くたびに呼ばれる。以前は 11 回目から 429 になり、写真解析の枠も使い切っていた
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await POST(makeRequest());
      statuses.push(res.status);
    }
    expect(statuses).toEqual(new Array(25).fill(200));

    // 同じユーザーが写真解析などで使う 'analysis' の枠は、ヒントの呼び出しで 1 回も減っていない
    // (未使用なら、この判定が 1 回目の消費になり、残りは 上限 - 1)
    const next = await checkRateLimit(RATE_LIMIT_USER_ID, 'analysis');
    expect(next.success).toBe(true);
    expect(next.remaining).toBe(next.limit - 1);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

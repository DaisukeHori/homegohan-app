/**
 * GET /api/super-admin/llm/usage の回帰テスト (#1306・#1433・#1463・#1482・#1498)
 *
 * #1498: 集計は DB の関数 llm_usage_summary (supabase/migrations/20261011110000_llm_usage_summary.sql) で行う。
 *   以前は llm_usage_logs の行を 5,000 行 (MAX_ROWS) まで読んで集計していたが、行は PostgREST の max_rows (既定 1,000) でも
 *   打ち切られるので、1,000 行を超える期間の合計は実際より小さく、異常使用 (1 人・JST の 1 日に 5,000 回超) は判定できなかった。
 *
 * ここでは DB の関数をモックし、route が
 *   - 認可 (super_admin) と入力の検査を通ったあとにだけ、service role のクライアントで関数を 1 回呼ぶこと
 *   - 期間 (JST 0 時の時刻)・絞り込み・上位の人数・異常のしきい値を引数で渡すこと (しきい値は LLM_USAGE_ANOMALY_DAILY_REQUESTS)
 *   - 関数の応答を、以前と同じ項目名の応答に直すこと (丸め・プロバイダー・user_id の NULL・異常の印)
 *   - 関数の失敗・応答の形の誤りを 500 にして記録すること (黙って 0 件にしない)
 *   - 開始日が終了日より後の期間は、関数を呼ばずに 400 にすること (関数は 22023 で拒むので、通すと 500 になる)
 * を確かめる。集計そのもの (合計行を数えない・NULL を 0 として足す・JST の暦日・しきい値の境界・打ち切りが無いこと・権限) は
 * 実 DB の tests/integration/security/llm-usage-summary.test.ts で確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { LLM_USAGE_ANOMALY_DAILY_REQUESTS } from '@/lib/super-admin/llm-usage-anomaly';
import type { LlmUsageSummaryRpc } from '@/lib/super-admin/llm-usage-summary';
import { TEST_TIME_ZONES } from './helpers/time-zones';

const rpc = vi.hoisted(() => vi.fn());
const getSupabaseAdmin = vi.hoisted(() => vi.fn());
const createClient = vi.hoisted(() => vi.fn());
const requireRole = vi.hoisted(() => vi.fn());
/** createLogger(...).withUser(user.id).error の呼び出し (DB エラーの記録) */
const logUserError = vi.hoisted(() => vi.fn());
/** createLogger(...).error の呼び出し (想定外の例外の記録) */
const logError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/helpers', () => ({ requireRole }));

vi.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin, createClient }));

vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: logError,
    withUser: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logUserError })),
  })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

import { GET } from '../src/app/api/super-admin/llm/usage/route';

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_A = '00000000-0000-4000-8000-0000000000b1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
/** JST 2026-10-08 14:00 (UTC 05:00)。期間の計算 (JST の今日 / 7 日前) がこの日付を基準にする */
const NOW = '2026-10-08T05:00:00.000Z';
/** DB の関数の名前 (手で書いた期待値) */
const EXPECTED_RPC = 'llm_usage_summary';
/** 上位の人数 (以前の route の Top 50。手で書いた期待値) */
const EXPECTED_TOP_USERS_LIMIT = 50;
/** 異常のしきい値 (設計書 operator/03-ui-spec.md「1 ユーザー 5,000 req/日超」。手で書いた期待値) */
const EXPECTED_ANOMALY_DAILY_REQUESTS = 5000;

/** 何も無い期間の応答 */
function emptySummary(): LlmUsageSummaryRpc {
  return {
    total_requests: 0,
    total_tokens: 0,
    total_cost_usd: 0,
    by_model: [],
    by_function: [],
    top_users: [],
    timeseries: [],
    anomalous_users: [],
  };
}

/** gpt-5-mini を 2 回 + grok を 1 回 (USER_A)。DB の関数が返す形 */
function sampleSummary(): LlmUsageSummaryRpc {
  return {
    total_requests: 3,
    total_tokens: 600,
    total_cost_usd: 1,
    by_model: [
      { model: 'gpt-5-mini', requests: 2, tokens: 300, cost_usd: 1 },
      { model: 'grok-4-1-fast-non-reasoning', requests: 1, tokens: 300, cost_usd: 0 },
    ],
    by_function: [{ function_name: 'generate-menu-v4', requests: 3, cost_usd: 1 }],
    top_users: [{ user_id: USER_A, requests: 3, cost_usd: 1 }],
    timeseries: [{ date: '2026-10-08', requests: 3, cost_usd: 1 }],
    anomalous_users: [],
  };
}

function respond(data: unknown, error: { code: string; message: string } | null = null) {
  rpc.mockResolvedValue({ data: error ? null : data, error });
}

const request = (query = '') => new Request(`http://localhost/api/super-admin/llm/usage${query}`) as never;

/** route が関数に渡した引数 (1 回目) */
function rpcArgs(): Record<string, unknown> {
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc.mock.calls[0][0]).toBe(EXPECTED_RPC);
  return rpc.mock.calls[0][1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  requireRole.mockResolvedValue({ id: ADMIN_ID, roles: ['super_admin'] });
  getSupabaseAdmin.mockReturnValue({ rpc });
  respond(sampleSummary());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/super-admin/llm/usage: DB の関数の呼び方 (#1498)', () => {
  it('service role のクライアントで llm_usage_summary を 1 回呼ぶ。行は読まない (利用者のセッションのクライアントも作らない)', async () => {
    const res = await GET(request('?period=7d'));

    expect(res.status).toBe(200);
    expect(getSupabaseAdmin).toHaveBeenCalledTimes(1);
    expect(createClient).not.toHaveBeenCalled();
    // 7d は JST の今日 (10/8) を含む 7 日間 (#1463)。開始日 10/2 の JST 0 時から、終了日の翌日 10/9 の JST 0 時の手前まで
    expect(rpcArgs()).toEqual({
      p_from: '2026-10-01T15:00:00.000Z',
      p_to_exclusive: '2026-10-08T15:00:00.000Z',
      p_model: null,
      p_function_name: null,
      p_provider: null,
      p_top_users_limit: EXPECTED_TOP_USERS_LIMIT,
      p_anomaly_daily_requests: EXPECTED_ANOMALY_DAILY_REQUESTS,
    });
  });

  it('異常のしきい値は、判定と画面の文に使う定数 LLM_USAGE_ANOMALY_DAILY_REQUESTS をそのまま渡す (値を 2 か所に書かない)', async () => {
    await GET(request());
    expect(rpcArgs().p_anomaly_daily_requests).toBe(LLM_USAGE_ANOMALY_DAILY_REQUESTS);
  });

  it('絞り込み (model / function / provider) を引数で渡す', async () => {
    await GET(request('?model=gpt-5-mini&function=generate-menu-v4&provider=openai'));

    expect(rpcArgs()).toMatchObject({ p_model: 'gpt-5-mini', p_function_name: 'generate-menu-v4', p_provider: 'openai' });
  });

  it('期間: custom は from / to を JST 0 時の時刻で渡す (開始日の JST 0 時以上・終了日の翌日の JST 0 時未満。#1433)', async () => {
    const res = await GET(request('?period=custom&from=2026-10-02&to=2026-10-05'));

    expect((await res.json()).data.period).toEqual({ from: '2026-10-02', to: '2026-10-05' });
    expect(rpcArgs()).toMatchObject({ p_from: '2026-10-01T15:00:00.000Z', p_to_exclusive: '2026-10-05T15:00:00.000Z' });
  });

  it('期間: 1d は JST の今日だけ (#1463)', async () => {
    const res = await GET(request('?period=1d'));

    expect((await res.json()).data.period).toEqual({ from: '2026-10-08', to: '2026-10-08' });
    expect(rpcArgs()).toMatchObject({ p_from: '2026-10-07T15:00:00.000Z', p_to_exclusive: '2026-10-08T15:00:00.000Z' });
  });
});

/**
 * JST 0:00 ちょうどと 8:59:59 (UTC ではまだ前日) に period=1d を開いたとき。どちらも JST の今日は 10/10 で、期間は 10/10 だけ (#1463)。
 * #1433 より前は開始日を UTC の暦日のまま timestamptz と比べていたので、JST 8:59:59 には開始日の JST 0:00〜8:59 の行が落ちていた。
 */
describe.each([
  { label: 'JST 10/10 0:00 ちょうど', now: '2026-10-09T15:00:00.000Z' },
  { label: 'JST 10/10 8:59:59', now: '2026-10-09T23:59:59.000Z' },
])('GET /api/super-admin/llm/usage: 境界 ($label)', ({ now }) => {
  it.each(TEST_TIME_ZONES)('TZ=%s でも、条件は 10/10 の JST 0 時から 10/11 の JST 0 時の手前まで', async (tz) => {
    const savedTz = process.env.TZ;
    process.env.TZ = tz;
    try {
      vi.setSystemTime(new Date(now));

      const { data } = await (await GET(request('?period=1d'))).json();

      expect(data.period).toEqual({ from: '2026-10-10', to: '2026-10-10' });
      expect(rpcArgs()).toMatchObject({ p_from: '2026-10-09T15:00:00.000Z', p_to_exclusive: '2026-10-10T15:00:00.000Z' });
    } finally {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    }
  });
});

describe('GET /api/super-admin/llm/usage: 応答の形 (以前と同じ項目名)', () => {
  it('レスポンスの項目名は従来のまま (画面は cost_usd などの名前を読む)', async () => {
    const res = await GET(request('?period=7d'));
    const { data } = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(data).sort()).toEqual(
      [
        'anomalies',
        'by_function',
        'by_model',
        'period',
        'timeseries',
        'top_users',
        'total_cost_jpy',
        'total_cost_usd',
        'total_requests',
        'total_tokens',
      ].sort(),
    );
    expect(data).toEqual({
      total_cost_usd: 1,
      total_cost_jpy: 152,
      total_requests: 3,
      total_tokens: 600,
      by_model: [
        { model: 'gpt-5-mini', provider: 'openai', requests: 2, tokens: 300, cost_usd: 1 },
        { model: 'grok-4-1-fast-non-reasoning', provider: 'xai', requests: 1, tokens: 300, cost_usd: 0 },
      ],
      by_function: [{ function: 'generate-menu-v4', requests: 3, cost_usd: 1 }],
      top_users: [{ user_id: USER_A, email: null, requests: 3, cost_usd: 1, is_anomaly: false }],
      timeseries: [{ date: '2026-10-08', cost_usd: 1, requests: 3 }],
      anomalies: [],
      period: { from: '2026-10-02', to: '2026-10-08' },
    });
  });

  it('合計のコストはセント、ユーザー別のコストは小数 5 桁で丸め、円は 152 円/ドルの概算 (以前と同じ)', async () => {
    respond({
      ...sampleSummary(),
      total_cost_usd: 1.23456,
      top_users: [{ user_id: USER_A, requests: 3, cost_usd: 0.123456789 }],
    });

    const { data } = await (await GET(request())).json();

    expect(data.total_cost_usd).toBe(1.23);
    expect(data.total_cost_jpy).toBe(188); // 1.23456 × 152 = 187.65…
    expect(data.top_users[0].cost_usd).toBe(0.12346);
  });

  it('プロバイダーはモデル名から決める (gemini / imagen・claude・gpt / o1・grok、ほかは unknown)', async () => {
    respond({
      ...emptySummary(),
      by_model: ['gemini-2.5', 'imagen-4', 'claude-x', 'gpt-4o', 'o1-mini', 'grok-4', 'mystery'].map((model) => ({
        model,
        requests: 1,
        tokens: 0,
        cost_usd: 0,
      })),
    });

    const { data } = await (await GET(request())).json();

    expect(data.by_model.map((m: { provider: string }) => m.provider)).toEqual([
      'gemini',
      'gemini',
      'anthropic',
      'openai',
      'openai',
      'xai',
      'unknown',
    ]);
  });

  it('user_id が NULL の行 (まとめた 1 人) は "unknown" として返す', async () => {
    respond({ ...sampleSummary(), top_users: [{ user_id: null, requests: 3, cost_usd: 1 }] });

    const { data } = await (await GET(request())).json();

    expect(data.top_users).toEqual([{ user_id: 'unknown', email: null, requests: 3, cost_usd: 1, is_anomaly: false }]);
  });

  it('行が無い期間は 0 件で返す', async () => {
    respond(emptySummary());

    const { data } = await (await GET(request())).json();

    expect(data).toMatchObject({
      total_cost_usd: 0,
      total_cost_jpy: 0,
      total_requests: 0,
      total_tokens: 0,
      by_model: [],
      by_function: [],
      top_users: [],
      timeseries: [],
      anomalies: [],
    });
  });
});

describe('GET /api/super-admin/llm/usage: 異常使用 (1 人・JST の 1 日に 5,000 回超。#1482・#1498)', () => {
  it('DB の関数が返した異常のユーザーを anomalies に載せ、top_users の同じ人に印を付ける', async () => {
    respond({
      ...sampleSummary(),
      top_users: [
        { user_id: USER_A, requests: 9000, cost_usd: 3 },
        { user_id: USER_B, requests: 10, cost_usd: 0.1 },
      ],
      anomalous_users: [{ user_id: USER_A, max_daily_requests: 5001, requests: 9000, cost_usd: 3 }],
    });

    const { data } = await (await GET(request())).json();

    expect(data.top_users.map((u: { user_id: string; is_anomaly: boolean }) => [u.user_id, u.is_anomaly])).toEqual([
      [USER_A, true],
      [USER_B, false],
    ]);
    expect(data.anomalies).toEqual([{ user_id: USER_A, email: null, requests: 9000, cost_usd: 3, is_anomaly: true }]);
  });

  it('上位 50 人に入らない異常のユーザーも anomalies に載せる (以前は上位の人だけで、バナーが出なかった)', async () => {
    const top = Array.from({ length: EXPECTED_TOP_USERS_LIMIT }, (_, i) => ({
      user_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      requests: 100_000,
      cost_usd: 1,
    }));
    respond({
      ...sampleSummary(),
      top_users: top,
      anomalous_users: [{ user_id: USER_B, max_daily_requests: 6000, requests: 6000, cost_usd: 2 }],
    });

    const { data } = await (await GET(request('?period=30d'))).json();

    expect(data.top_users).toHaveLength(EXPECTED_TOP_USERS_LIMIT);
    expect(data.top_users.some((u: { is_anomaly: boolean }) => u.is_anomaly)).toBe(false);
    expect(data.anomalies).toEqual([{ user_id: USER_B, email: null, requests: 6000, cost_usd: 2, is_anomaly: true }]);
  });

  it('ちょうど 5,000 回の日しか無い人は異常にしない (DB の絞り込みに頼らず、同じ定数でもう一度判定する)', async () => {
    respond({
      ...sampleSummary(),
      anomalous_users: [{ user_id: USER_A, max_daily_requests: EXPECTED_ANOMALY_DAILY_REQUESTS, requests: 9000, cost_usd: 3 }],
    });

    const { data } = await (await GET(request())).json();

    expect(data.anomalies).toEqual([]);
    expect(data.top_users[0].is_anomaly).toBe(false);
  });

  it('user_id が NULL の行の異常は "unknown" として載せる', async () => {
    respond({
      ...sampleSummary(),
      top_users: [{ user_id: null, requests: 5001, cost_usd: 1 }],
      anomalous_users: [{ user_id: null, max_daily_requests: 5001, requests: 5001, cost_usd: 1 }],
    });

    const { data } = await (await GET(request())).json();

    expect(data.anomalies.map((u: { user_id: string }) => u.user_id)).toEqual(['unknown']);
    expect(data.top_users[0]).toMatchObject({ user_id: 'unknown', is_anomaly: true });
  });
});

describe('GET /api/super-admin/llm/usage: 入力・認可・エラー', () => {
  it('不正なクエリ (period=90d) は 400。DB には触れない', async () => {
    const res = await GET(request('?period=90d'));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('存在しない日付 (from=2026-02-30 / to=2026-13-01) は 400。DB には触れない (JST 0 時の時刻に直す前に入口で弾く)', async () => {
    for (const query of [
      '?period=custom&from=2026-02-30',
      '?period=custom&from=2026-10-01&to=2026-13-01',
      // 実在するが受け付ける範囲 (0101-01-02〜9998-12-30) の外。翌日の JST 0 時を求められず、通すと 500 になる
      '?period=custom&from=2026-10-01&to=9999-12-31',
      '?period=7d&to=9999-12-31',
    ]) {
      const res = await GET(request(query));
      expect(res.status, query).toBe(400);
      expect((await res.json()).error.code, query).toBe('VALIDATION_ERROR');
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  // #1498: DB の関数は開始の時刻 ≥ 終わりの時刻を 22023 で拒む。route が判定せずに呼ぶと、利用者の入力の誤りが
  // 500 (INTERNAL_ERROR) になり、サーバーの障害として app_logs に記録されていた (以前の route は 0 行を読んで 200 だった)
  it.each([
    ['custom で開始日が終了日より後', '?period=custom&from=2026-10-10&to=2026-10-05'],
    ['custom で開始日が終了日の翌日 (JST 0 時の時刻が同じになる)', '?period=custom&from=2026-10-06&to=2026-10-05'],
    // NOW は JST 2026-10-08。7d の開始日は 10/2 で、終了日 10/1 より後になる
    ['7d に開始日より前の終了日 (to=2026-10-01)', '?period=7d&to=2026-10-01'],
    // 30d の開始日は 9/9 で、終了日 9/8 より後になる
    ['30d に開始日より前の終了日 (to=2026-09-08)', '?period=30d&to=2026-09-08'],
  ])('開始日が終了日より後の期間 (%s) は 400。DB には触れず、障害として記録しない', async (_label, query) => {
    const res = await GET(request(query));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(json.error.details.fieldErrors.from).toEqual(['開始日は終了日と同じ日かそれより前にしてください']);
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(logUserError).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it.each([
    ['custom で開始日と終了日が同じ日', '?period=custom&from=2026-10-05&to=2026-10-05', '2026-10-04T15:00:00.000Z', '2026-10-05T15:00:00.000Z'],
    // 7d の開始日 10/2 と終了日が同じ日。境界 (開始日 = 終了日) は受け付ける
    ['7d に開始日と同じ日の終了日 (to=2026-10-02)', '?period=7d&to=2026-10-02', '2026-10-01T15:00:00.000Z', '2026-10-02T15:00:00.000Z'],
  ])('開始日と終了日が同じ日 (%s) は 200 で、その 1 日を関数に渡す', async (_label, query, pFrom, pToExclusive) => {
    const res = await GET(request(query));

    expect(res.status).toBe(200);
    expect(rpcArgs()).toMatchObject({ p_from: pFrom, p_to_exclusive: pToExclusive });
  });

  it('DB の関数のエラーは 500 で返し、原因と検索条件を記録する (エラー文は画面に出さない)', async () => {
    respond(null, { code: 'PGRST202', message: 'Could not find the function public.llm_usage_summary' });

    const res = await GET(request('?period=7d&model=gpt-5-mini'));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('llm_usage_summary');
    expect(logUserError).toHaveBeenCalledWith(
      'LLM 使用量の集計に失敗',
      expect.any(Error),
      expect.objectContaining({
        pg_code: 'PGRST202',
        period: '7d',
        from: '2026-10-02', // 7d は JST の今日 (10/8) を含む 7 日間 (#1463)
        to: '2026-10-08',
        model: 'gpt-5-mini',
      }),
    );
    // postgrest-js の error は Error ではない素のオブジェクトで、そのまま渡すと db-logger が
    // app_logs.error_message に '[object Object]' を書く。message を持つ Error に包んで渡し、原因が読めるようにする
    const logged = logUserError.mock.calls[0][1];
    expect(logged).toBeInstanceOf(Error);
    expect(logged).toHaveProperty('message', 'Could not find the function public.llm_usage_summary');
  });

  it.each([
    ['null', null],
    ['配列 (行の集合)', [{ total_requests: 1 }]],
    ['項目が足りない', { total_requests: 1 }],
    ['回数が負', { ...emptySummary(), total_requests: -1 }],
    ['日付が実在しない', { ...emptySummary(), timeseries: [{ date: '2026-02-30', requests: 1, cost_usd: 0 }] }],
  ])('DB の関数の応答の形が想定と違う (%s) ときは 500 にして記録する。黙って 0 件にしない', async (_label, data) => {
    respond(data);

    const res = await GET(request('?period=7d'));

    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('INTERNAL_ERROR');
    expect(logUserError).toHaveBeenCalledWith(
      'LLM 使用量の集計の応答の形が想定と違う',
      expect.any(Error),
      expect.objectContaining({ period: '7d', from: '2026-10-02', to: '2026-10-08' }),
    );
  });

  it('未認証は 401、権限が無ければ 403。DB には触れない (service role のクライアントも作らない)', async () => {
    requireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    expect((await GET(request())).status).toBe(401);

    requireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED', 'Requires one of: super_admin'));
    expect((await GET(request())).status).toBe(403);

    expect(requireRole).toHaveBeenCalledWith(['super_admin']);
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('想定外の例外は 500 にして記録する (例外の文は画面に出さない)', async () => {
    const boom = new Error('boom: internal detail');
    requireRole.mockRejectedValueOnce(boom);

    const res = await GET(request());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('internal detail');
    expect(logError).toHaveBeenCalledWith(expect.any(String), boom);
  });
});

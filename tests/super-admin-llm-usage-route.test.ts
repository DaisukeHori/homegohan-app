/**
 * #1306: GET /api/super-admin/llm/usage の回帰テスト
 *
 * llm_usage_logs の実際の列は input_tokens / output_tokens / total_tokens / estimated_cost_usd。
 * 修正前は存在しない prompt_tokens / completion_tokens / cost_usd を select していたため、
 * 本番では PostgREST が 42703 で失敗し、LLM 使用量の画面は常に 500 だった。
 * 単体テストは Supabase をモックして列の有無を見ないため、検出できなかった。
 *
 * ここでは本番スキーマ (supabase/baseline/prod_schema.sql に新しい migration を重ねたもの) の列を知っているフェイク
 * (tests/helpers/schema-checked-supabase.ts) を使い、存在しない列を読むと失敗する状態で確かめる。
 * 実 DB での確認は tests/integration/security/super-admin-columns.test.ts と select-columns-exist.test.ts。
 *
 * あわせて、Edge Function (supabase/functions/_shared/llm-usage.ts) が LLM 呼び出しごとの行のほかに
 * 1 回の実行ごとの合計行 (is_summary = true, model = 'mixed') を入れることを踏まえ、
 * 合計行を二重に数えないことも確かめる (クエリが通るようになって初めて表に出る不具合)。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import {
  createSchemaCheckedDb,
  pgError,
  schemaColumns,
  type SchemaCheckedDb,
} from './helpers/schema-checked-supabase';

const state = vi.hoisted(() => ({ supabase: null as unknown }));
const requireRole = vi.hoisted(() => vi.fn());
/** createLogger(...).withUser(user.id).error の呼び出し (DB エラーの記録) */
const logUserError = vi.hoisted(() => vi.fn());
/** createLogger(...).error の呼び出し (想定外の例外の記録) */
const logError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/helpers', () => ({ requireRole }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => state.supabase,
}));

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
/** 2026-10-08 (UTC)。期間の計算 (today / 7 日前) がこの日付を基準にする */
const NOW = '2026-10-08T05:00:00.000Z';

/** llm_usage_logs の 1 行。既定は「gpt-5-mini を 1 回呼んだ」行 (is_summary = false) */
function usage(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    created_at: NOW,
    function_name: 'generate-menu-v4',
    execution_id: '33333333-3333-4333-8333-333333333333',
    user_id: USER_A,
    provider: 'openai',
    endpoint: '/v1/chat/completions',
    model: 'gpt-5-mini',
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    estimated_cost_usd: 0.5,
    is_summary: false,
    success: true,
    ...overrides,
  };
}

let db: SchemaCheckedDb;

function setup(rows: Array<Record<string, unknown>>) {
  db = createSchemaCheckedDb({ llm_usage_logs: rows });
  state.supabase = db.supabase;
}

const request = (query = '') => new Request(`http://localhost/api/super-admin/llm/usage${query}`) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  requireRole.mockResolvedValue({ id: ADMIN_ID, roles: ['super_admin'] });
  setup([usage()]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/super-admin/llm/usage: 列名', () => {
  it('select する列は、すべて本番スキーマの llm_usage_logs に存在する (prompt_tokens / completion_tokens / cost_usd を読まない)', async () => {
    const res = await GET(request());

    expect(res.status).toBe(200);
    const select = db.calls.find((c) => c.table === 'llm_usage_logs' && c.op === 'select')!;
    const selected = select.columns!.split(',').map((s) => s.trim());
    const real = schemaColumns('llm_usage_logs');
    for (const old of ['prompt_tokens', 'completion_tokens', 'cost_usd']) {
      expect(selected).not.toContain(old);
    }
    for (const name of selected) {
      expect(real).toContain(name);
    }
    // 金額は estimated_cost_usd、トークンは total_tokens から集計する
    expect(selected).toContain('estimated_cost_usd');
    expect(selected).toContain('total_tokens');
  });

  it('フィルタに使う列 (is_summary / created_at / model / function_name / provider) も本番に存在する', async () => {
    await GET(request('?model=gpt-5-mini&function=generate-menu-v4&provider=openai'));

    const select = db.calls.find((c) => c.op === 'select')!;
    const real = schemaColumns('llm_usage_logs');
    expect(select.filters.map((f) => f.column).sort()).toEqual(
      ['created_at', 'created_at', 'function_name', 'is_summary', 'model', 'provider'].sort(),
    );
    for (const filter of select.filters) {
      expect(real).toContain(filter.column);
    }
  });
});

describe('GET /api/super-admin/llm/usage: 集計', () => {
  it('実行ごとの合計行 (is_summary = true) を数えず、LLM 呼び出しごとの行だけを集計する', async () => {
    // 1 回の実行 = gpt-5-mini 2 回 + grok 1 回 + それらの合計行 (Edge Function はこの 4 行を入れる)
    setup([
      usage({ total_tokens: 150, estimated_cost_usd: 0.5 }),
      usage({ total_tokens: 150, estimated_cost_usd: 0.5 }),
      usage({
        model: 'grok-4-1-fast-non-reasoning',
        provider: 'xai',
        total_tokens: 300,
        estimated_cost_usd: null, // 単価表に無いモデルは推定コストが null
      }),
      usage({
        model: 'mixed',
        provider: 'mixed',
        endpoint: 'summary',
        total_tokens: 600,
        estimated_cost_usd: 1,
        is_summary: true,
      }),
    ]);

    const res = await GET(request('?period=7d'));
    const { data } = await res.json();

    expect(res.status).toBe(200);
    expect(data.total_requests).toBe(3);
    expect(data.total_tokens).toBe(600);
    expect(data.total_cost_usd).toBe(1);
    expect(data.total_cost_jpy).toBe(152);
    expect(data.by_model).toEqual([
      { model: 'gpt-5-mini', provider: 'openai', requests: 2, tokens: 300, cost_usd: 1 },
      { model: 'grok-4-1-fast-non-reasoning', provider: 'xai', requests: 1, tokens: 300, cost_usd: 0 },
    ]);
    expect(data.by_function).toEqual([{ function: 'generate-menu-v4', requests: 3, cost_usd: 1 }]);
    expect(data.by_model.map((m: { model: string }) => m.model)).not.toContain('mixed');
  });

  it('レスポンスの項目名は従来のまま (画面は cost_usd などの名前を読む)', async () => {
    const res = await GET(request('?period=7d'));
    const { data } = await res.json();

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
    expect(data.by_model[0]).toEqual({
      model: 'gpt-5-mini',
      provider: 'openai',
      requests: 1,
      tokens: 150,
      cost_usd: 0.5,
    });
    expect(data.top_users[0]).toEqual({
      user_id: USER_A,
      email: null,
      requests: 1,
      cost_usd: 0.5,
      is_anomaly: false,
    });
    expect(data.timeseries).toEqual([{ date: '2026-10-08', cost_usd: 0.5, requests: 1 }]);
    expect(data.anomalies).toEqual([]);
    expect(data.period).toEqual({ from: '2026-10-01', to: '2026-10-08' });
  });

  it('コストやトークンが null の行 (単価表に無いモデルなど) は 0 として足す。NaN にしない', async () => {
    setup([
      usage({ estimated_cost_usd: null, total_tokens: null }),
      usage({ estimated_cost_usd: 0.25, total_tokens: 40 }),
    ]);

    const res = await GET(request());
    const { data } = await res.json();

    expect(data.total_requests).toBe(2);
    expect(data.total_tokens).toBe(40);
    expect(data.total_cost_usd).toBe(0.25);
    expect(data.by_model[0].cost_usd).toBe(0.25);
  });

  it('ユーザー別は呼び出し回数の多い順、日次は日付の昇順、1 ユーザーが 5,000 回を超えたら異常として返す', async () => {
    setup([
      usage({ user_id: USER_B, created_at: '2026-10-07T01:00:00.000Z', estimated_cost_usd: 0.1 }),
      usage({ user_id: USER_A, created_at: '2026-10-08T01:00:00.000Z', estimated_cost_usd: 0.2 }),
      usage({ user_id: USER_A, created_at: '2026-10-08T02:00:00.000Z', estimated_cost_usd: 0.3 }),
    ]);

    const { data } = await (await GET(request())).json();

    expect(data.top_users.map((u: { user_id: string }) => u.user_id)).toEqual([USER_A, USER_B]);
    expect(data.top_users[0]).toMatchObject({ requests: 2, cost_usd: 0.5 });
    expect(data.timeseries).toEqual([
      { date: '2026-10-07', cost_usd: 0.1, requests: 1 },
      { date: '2026-10-08', cost_usd: 0.5, requests: 2 },
    ]);
    expect(data.anomalies).toEqual([]);
  });

  it('行数が上限 (5,000 行) を超えるときは、新しい行から集計する (落ちるのは古い行)', async () => {
    // 古い順に 5,001 行。並べ替えが無いと、先頭から 5,000 行を取るので、いちばん新しい行が落ちる
    const start = Date.parse('2026-10-05T00:00:00.000Z');
    const rows = Array.from({ length: 5001 }, (_, i) =>
      usage({
        created_at: new Date(start + i * 1000).toISOString(),
        function_name: i === 0 ? 'oldest' : i === 5000 ? 'newest' : 'middle',
      }),
    );
    setup(rows);

    const { data } = await (await GET(request('?period=7d'))).json();

    expect(data.total_requests).toBe(5000);
    const functions = data.by_function.map((f: { function: string }) => f.function);
    expect(functions).toContain('newest');
    expect(functions).not.toContain('oldest');
  });

  it('行が無い期間は 0 件で返す', async () => {
    setup([]);

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

describe('GET /api/super-admin/llm/usage: 絞り込み', () => {
  const rows = () => [
    usage({ model: 'gpt-5-mini', provider: 'openai', function_name: 'fn-a' }),
    usage({ model: 'gpt-4o', provider: 'openai', function_name: 'fn-b' }),
    usage({ model: 'grok-4-1-fast', provider: 'xai', function_name: 'fn-a' }),
  ];

  it('provider: プロバイダー別の画面が渡すプロバイダーの行だけを集計する', async () => {
    setup(rows());

    const { data } = await (await GET(request('?provider=xai'))).json();

    expect(data.total_requests).toBe(1);
    expect(data.by_model.map((m: { model: string }) => m.model)).toEqual(['grok-4-1-fast']);
  });

  it('model / function: 指定した値の行だけを集計する', async () => {
    setup(rows());

    const byModel = await (await GET(request('?model=gpt-4o'))).json();
    expect(byModel.data.total_requests).toBe(1);
    expect(byModel.data.by_function.map((f: { function: string }) => f.function)).toEqual(['fn-b']);

    const byFunction = await (await GET(request('?function=fn-a'))).json();
    expect(byFunction.data.total_requests).toBe(2);
  });

  it('期間: 1d は昨日から、custom は from / to の範囲だけを集計する', async () => {
    setup([
      usage({ created_at: '2026-09-30T23:00:00.000Z' }),
      usage({ created_at: '2026-10-02T00:00:00.000Z' }),
      usage({ created_at: '2026-10-05T23:59:00.000Z' }),
      usage({ created_at: '2026-10-06T00:00:00.000Z' }),
      usage({ created_at: '2026-10-08T01:00:00.000Z' }),
    ]);

    const custom = await (await GET(request('?period=custom&from=2026-10-02&to=2026-10-05'))).json();
    expect(custom.data.period).toEqual({ from: '2026-10-02', to: '2026-10-05' });
    expect(custom.data.total_requests).toBe(2);

    const oneDay = await (await GET(request('?period=1d'))).json();
    expect(oneDay.data.period).toEqual({ from: '2026-10-07', to: '2026-10-08' });
    expect(oneDay.data.total_requests).toBe(1);
  });
});

describe('GET /api/super-admin/llm/usage: 入力・認可・エラー', () => {
  it('不正なクエリ (period=90d) は 400。DB には触れない', async () => {
    const res = await GET(request('?period=90d'));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
    expect(db.calls).toHaveLength(0);
  });

  it('DB のエラーは 500 で返し、原因と検索条件を記録する (エラー文は画面に出さない)', async () => {
    const error = pgError('42703', 'column llm_usage_logs.cost_usd does not exist');
    db.failNext('llm_usage_logs', 'select', error);

    const res = await GET(request('?period=7d&model=gpt-5-mini'));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('cost_usd');
    expect(logUserError).toHaveBeenCalledWith(
      'LLM 使用量ログの取得に失敗',
      expect.any(Error),
      expect.objectContaining({
        pg_code: '42703',
        period: '7d',
        from: '2026-10-01',
        to: '2026-10-08',
        model: 'gpt-5-mini',
      }),
    );
    // postgrest-js の error は Error ではない素のオブジェクトで、そのまま渡すと db-logger が
    // app_logs.error_message に '[object Object]' を書く。message を持つ Error に包んで渡し、原因が読めるようにする
    const logged = logUserError.mock.calls[0][1];
    expect(logged).toBeInstanceOf(Error);
    expect(logged).toHaveProperty('message', 'column llm_usage_logs.cost_usd does not exist');
  });

  it('未認証は 401、権限が無ければ 403。DB には触れない', async () => {
    requireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    expect((await GET(request())).status).toBe(401);

    requireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED', 'Requires one of: super_admin'));
    expect((await GET(request())).status).toBe(403);

    expect(requireRole).toHaveBeenCalledWith(['super_admin']);
    expect(db.calls).toHaveLength(0);
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

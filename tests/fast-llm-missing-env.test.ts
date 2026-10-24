// @vitest-environment node
/**
 * #1490 Web の fast-llm (src/lib/ai/fast-llm.ts) が、XAI_API_KEY が無いときに変数名入りの文を投げていた問題の回帰テスト
 *
 * 以前は `throw new Error("Missing XAI_API_KEY")` だった。呼び出し元の route は message を本文に入れていないので
 * 利用者には届かなかったが、#1182 の「例外の message に変数名を入れない」に外れていた
 * (catch が message を本文や記録に入れる route が書かれると、変数名が外に出る)。
 * tests/env-source-scan.test.ts の「例外・応答の文字列に変数名を書かない」検査は必須の 3 つの名前しか見ておらず、
 * 任意の変数 XAI_API_KEY をすり抜けていた (いまは一覧の全変数を見る)。
 *
 * いまは:
 *  - XAI_API_KEY を getOptionalEnv で取り出し (無ければ変数名入りの警告をサーバーのログに 1 回だけ出す)、
 *    無ければ src/lib/env-required.ts の MissingEnvError を投げる。message は固定の文で、変数名は envName にだけ入る。
 *  - 呼び出し元の応答は変わらない (POST /api/ai/nutrition は以前と同じ汎用の 500)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

/** route は UUID の形でない id を DB に渡さず 404 にする (#1917) ので、id は UUID の形にする */
const MEAL_ID = '99999999-9999-4999-8999-999999999992';

// 1 件のテストの中で route を丸ごと読み込むので、負荷の高い機械で vitest の既定の時間切れ (テスト 5 秒) を超えうる (#1605 の同じ型)。
// このファイルだけ延ばす (根拠と環境変数での上書きは tests/helpers/heavy-unit-test-timeout.ts。#1488・#1605)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

const h = vi.hoisted(() => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  getUser: vi.fn(),
  from: vi.fn(),
  consumeAiUsage: vi.fn(),
}));

// 構造化ログ (db-logger) は DB に書かず、呼び出しだけ見る。getOptionalEnv の警告 (src/lib/env.ts が動的に読む) も
// internalError() の記録も、ここに来る
vi.mock('@/lib/db-logger', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: h.logWarn,
    error: h.logError,
    withUser: () => logger,
  };
  return { createLogger: () => logger, generateRequestId: () => 'req_test' };
});

// POST /api/ai/nutrition の、AI を呼ぶ前の関門 (同意・レート制限・回数の上限) は通す
vi.mock('@/lib/ai/consent-guard', () => import('./helpers/ai-consent-guard-allowed'));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true })),
  rateLimitExceededResponse: vi.fn(),
}));
vi.mock('@/lib/plan/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plan/entitlements')>()),
  consumeAiUsage: h.consumeAiUsage,
}));
vi.mock('../lib/meal-image-jobs', () => ({
  cancelPendingMealImageJobs: vi.fn(async () => undefined),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: h.getUser }, from: h.from }),
  getSupabaseAdmin: () => ({ from: vi.fn() }),
}));

const ENV_NAME = 'XAI_API_KEY';
const originalValue = process.env[ENV_NAME];

/** fast-llm はクライアントをモジュールに持つので、毎回読み直す (env.ts の「1 回だけ出す警告」の記録も消える) */
async function loadFastLLM() {
  vi.resetModules();
  return import('../src/lib/ai/fast-llm');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (originalValue === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = originalValue;
});

describe('getFastLLMClient: XAI_API_KEY が無いとき (#1490)', () => {
  it.each([
    ['未設定', undefined],
    ['空', ''],
    ['空白だけ', '   '],
  ])('%s なら MissingEnvError を投げ、message にも JSON にも変数名を入れない。変数名は envName にだけ入る', async (_label, value) => {
    if (value === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = value;
    const { getFastLLMClient } = await loadFastLLM();
    const { isMissingEnvError, MISSING_ENV_ERROR_MESSAGE } = await import('../src/lib/env-required');

    let caught: unknown;
    try {
      getFastLLMClient();
    } catch (error) {
      caught = error;
    }

    expect(isMissingEnvError(caught)).toBe(true);
    const error = caught as Error & { envName: string };
    expect(error.message).toBe(MISSING_ENV_ERROR_MESSAGE);
    expect(error.message).not.toContain(ENV_NAME);
    expect(JSON.stringify(error)).not.toContain(ENV_NAME);
    expect(String(error)).not.toContain(ENV_NAME);
    // 欠けている変数名は envName (構造化ログの missing_env_name) にだけ残る
    expect(error.envName).toBe(ENV_NAME);
  });

  it('欠けている変数名は、サーバーのログ (getOptionalEnv の警告) に残る', async () => {
    delete process.env[ENV_NAME];
    const { getFastLLMClient } = await loadFastLLM();

    expect(() => getFastLLMClient()).toThrow();
    await vi.waitFor(() => expect(h.logWarn).toHaveBeenCalled());
    const [, metadata] = h.logWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(metadata.envName).toBe(ENV_NAME);
  });

  it('設定されていれば、前後の空白を除いた値でクライアントを作る (以前と同じ)', async () => {
    process.env[ENV_NAME] = '  test-xai-key  ';
    const { getFastLLMClient } = await loadFastLLM();

    const client = getFastLLMClient();

    expect(client.apiKey).toBe('test-xai-key');
    // XAI_API_KEY についての警告は出ない。ベース URL (XAI_BASE_URL) も getOptionalEnv で読むので (#1522)、
    // XAI_BASE_URL が未設定ならその警告は出てよい。ここで見るのは XAI_API_KEY の警告だけ
    await Promise.resolve();
    const warnedNames = h.logWarn.mock.calls.map(([, metadata]) => (metadata as { envName?: string } | undefined)?.envName);
    expect(warnedNames).not.toContain(ENV_NAME);
  });
});

describe('呼び出し元 POST /api/ai/nutrition の応答は変わらない (#1490)', () => {
  it('XAI_API_KEY が無いと、以前と同じ汎用の 500 (変数名を含まない)。記録には MissingEnvError が渡る', async () => {
    delete process.env[ENV_NAME];
    vi.resetModules();
    const { POST } = await import('../src/app/api/ai/nutrition/route');
    const { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } = await import('../src/lib/api/errors');
    const { isMissingEnvError } = await import('../src/lib/env-required');

    h.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    h.consumeAiUsage.mockResolvedValue({ allowed: true });
    const single = vi.fn(async () => ({
      data: { id: MEAL_ID, dishes: null, is_simple: true, user_daily_meals: { user_id: 'user-1' } },
      error: null,
    }));
    // 献立の所有の確認は maybeSingle で読む (#1917)
    const builder = { select: () => builder, eq: () => builder, single, maybeSingle: single };
    h.from.mockImplementation((table: string) => {
      if (table === 'planned_meals') return builder;
      throw new Error(`unexpected table: ${table}`);
    });

    const response = await POST(
      new Request('http://localhost/api/ai/nutrition', {
        method: 'POST',
        body: JSON.stringify({ plannedMealId: MEAL_ID, imageUrl: 'https://example.com/meal.jpg' }),
      }),
    );
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE });
    expect(text).not.toContain(ENV_NAME);
    // AI まで進んでから失敗している (前の関門で止まって別の 500 になっていない)
    expect(single).toHaveBeenCalledTimes(1);
    expect(h.consumeAiUsage).toHaveBeenCalledTimes(1);
    expect(h.logError).toHaveBeenCalledTimes(1);
    const loggedError = h.logError.mock.calls[0][1];
    expect(isMissingEnvError(loggedError)).toBe(true);
    expect((loggedError as { envName: string }).envName).toBe(ENV_NAME);
  });
});

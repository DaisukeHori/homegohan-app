/**
 * use-home-data-ai-get.test.tsx
 * ホームのデータ取得 (src/hooks/useHomeData.ts) のうち、サーバーで LLM を呼ぶ GET の通信設定のテスト (#1049 F7-12)
 *
 * GET /api/ai/nutrition-analysis?...includeAdvice=true&includeSuggestion=true は、サーバー側で LLM を 1 回呼ぶ
 * (時間制限は付いていない)。共通の通信部品 (@homegohan/core の createHttpClient) の GET は、
 * 通信エラーと 502 / 503 / 504 のときに既定で 2 回やり直すので、ゲートウェイ系のエラーが出ると、
 * ホームを 1 回読むだけで LLM の生成が最大 3 回走ってしまう。
 * 失敗してもホームの他の表示には影響しない (何も出さずに諦める) ので、この呼び出しはやり直さない ({ retries: 0 })。
 */

import { act, renderHook } from '@testing-library/react-native';
import { createHttpClient } from '@homegohan/core';

// ── Supabase のモック: どのクエリにも空の結果を返す ───────────────────────────────
function mockMakeBuilder() {
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'neq', 'gte', 'lte', 'gt', 'lt', 'not', 'order', 'limit', 'in', 'is', 'update', 'upsert', 'insert']) {
    builder[name] = () => builder;
  }
  builder.maybeSingle = () => Promise.resolve({ data: null, error: null });
  builder.single = () => Promise.resolve({ data: null, error: null });
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
  return builder;
}

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => mockMakeBuilder(),
  },
}));

// getApi() は、本物の通信部品を、テスト用の fetch で動かす
const mockFetch = jest.fn();
jest.mock('../../src/lib/api', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHttpClient: create } = require('@homegohan/core');
  const client = create({
    baseUrl: 'https://api.example.test',
    // 再試行の待ち時間を 0 にして、テストを速くする
    retryDelayMs: 0,
  });
  return { getApi: () => client };
});

import { useHomeData } from '../../src/hooks/useHomeData';

const NUTRITION_ANALYSIS_URL =
  'https://api.example.test/api/ai/nutrition-analysis?period=today&includeAdvice=true&includeSuggestion=true';

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText ?? '',
    text: async () => JSON.stringify(body),
  };
}

async function renderAndFlush() {
  renderHook(() => useHomeData('user-1'));
  // 再試行の待ち (retryDelayMs: 0) も含めて、通信が落ち着くまで待つ
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const callsTo = (url: string) => mockFetch.mock.calls.filter(([calledUrl]) => calledUrl === url);

beforeEach(() => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe('useHomeData — LLM を呼ぶ nutrition-analysis の GET は、やり直さない', () => {
  it('(前提) 共通の通信部品の GET は、502 のとき既定で 2 回やり直す (= retries: 0 を付けないと 3 回走る)', async () => {
    mockFetch.mockImplementation(async () => jsonResponse({}, { status: 502, statusText: 'Bad Gateway' }));
    const client = createHttpClient({ baseUrl: 'https://api.example.test', retryDelayMs: 0 });

    await expect(client.get('/api/ai/nutrition-analysis?period=today&includeAdvice=true')).rejects.toThrow('HTTP 502');

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('ゲートウェイのエラー (502) が返っても、サーバーへのリクエストは 1 回だけ', async () => {
    mockFetch.mockImplementation(async (url: string) =>
      url === NUTRITION_ANALYSIS_URL ? jsonResponse({}, { status: 502, statusText: 'Bad Gateway' }) : jsonResponse({}),
    );

    await renderAndFlush();

    expect(callsTo(NUTRITION_ANALYSIS_URL)).toHaveLength(1);
  });

  it('503 / 504 でも 1 回だけ', async () => {
    for (const [status, statusText] of [
      [503, 'Service Unavailable'],
      [504, 'Gateway Timeout'],
    ] as const) {
      mockFetch.mockReset();
      mockFetch.mockImplementation(async (url: string) =>
        url === NUTRITION_ANALYSIS_URL ? jsonResponse({}, { status, statusText }) : jsonResponse({}),
      );

      await renderAndFlush();

      expect(callsTo(NUTRITION_ANALYSIS_URL)).toHaveLength(1);
    }
  });

  it('ゲートウェイのエラーでも、ホームの画面は壊れない (栄養分析が読み込み中のまま残らない)', async () => {
    mockFetch.mockImplementation(async (url: string) =>
      url === NUTRITION_ANALYSIS_URL ? jsonResponse({}, { status: 504, statusText: 'Gateway Timeout' }) : jsonResponse({}),
    );

    const { result } = renderHook(() => useHomeData('user-1'));
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(result.current.nutritionAnalysis.loading).toBe(false);
    expect(result.current.nutritionAnalysis.advice).toBeNull();
  });

  it('成功したときは、助言と提案を受け取る (やり直さない設定にしても、通常の取得は変わらない)', async () => {
    mockFetch.mockImplementation(async (url: string) =>
      url === NUTRITION_ANALYSIS_URL
        ? jsonResponse({
            success: true,
            analysis: { score: 72, issues: ['食物繊維が不足'], comparison: {} },
            advice: '野菜を足しましょう',
            suggestion: null,
          })
        : jsonResponse({}),
    );

    const { result } = renderHook(() => useHomeData('user-1'));
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(callsTo(NUTRITION_ANALYSIS_URL)).toHaveLength(1);
    expect(result.current.nutritionAnalysis.score).toBe(72);
    expect(result.current.nutritionAnalysis.advice).toBe('野菜を足しましょう');
  });
});

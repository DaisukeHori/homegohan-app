// @vitest-environment node
/**
 * POST /api/shopping-list/regenerate が、Supabase の接続情報 (必須の環境変数) を取り出す順序のテスト (#1434)
 *
 * 必須の環境変数 (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) が欠けているとき (未設定・空・空白だけ):
 *   1. 未ログインの呼び出しには、設定の不足を教えず、これまでどおり 401 を返す
 *   2. レート制限を超えた呼び出しは、これまでどおり 429 を返す
 *   3. ログイン済みで制限内なら、DB に何も書く前 (AI 利用回数の記録・shopping_list_requests の行の作成より前) に、
 *      汎用の 500 (internalError の flat の形) で止める。本文には変数名を出さず (#1172)、変数名は構造化ログにだけ渡す。
 *      以前は行を status 'processing' で作ったあとで気づいて 500 にしており、Edge Function は呼ばれず、
 *      processing のまま残る行ができていた (processing の行を片付ける仕組みは無い)
 *   4. 設定が揃っていれば、記録・行の作成・Edge Function の呼び出しまで進む
 *      (3 が「そもそも DB に進まない」ことで成り立っているのではないことの確認)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUser = vi.fn();
const mockInsert = vi.fn();
const mockFrom = vi.fn((_table: string) => ({ insert: mockInsert }));
const mockCheckRateLimit = vi.fn();
const mockRecordAiUsage = vi.fn(async (_userId: string, _feature: string) => {});
const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));

// 同意の判定 (T15 / #1154) は「同意済み」に差し替える。同意が無いときに AI へ送らないことは tests/ai-consent-enforcement-routes.test.ts が実際の route を呼んで確かめる
vi.mock('@/lib/ai/consent-guard', () => import('../../../../tests/helpers/ai-consent-guard-allowed'));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser }, from: mockFrom })),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  rateLimitExceededResponse: vi.fn(() => new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 })),
}));

vi.mock('@/lib/plan/entitlements', () => ({
  recordAiUsage: (userId: string, feature: string) => mockRecordAiUsage(userId, feature),
}));

// internalError() が使う構造化ログ。変数名がここに渡ることを見る
const mockLoggerError = vi.fn();
vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    withUser: vi.fn().mockReturnThis(),
    error: mockLoggerError,
    warn: vi.fn(),
  })),
  generateRequestId: vi.fn(() => 'req-test'),
}));

const SUPABASE_URL = 'https://example.supabase.co';
const SERVICE_ROLE_KEY = 'service-role-key-for-test';
const REQUEST_ID = 'shopping-req-1';
const REQUIRED_NAMES = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
/** 欠けているとみなす値 (未設定・空・空白だけ。env-required の requireValue と同じ判定) */
const MISSING_VALUES: ReadonlyArray<readonly [string, string | undefined]> = [
  ['未設定', undefined],
  ['空', ''],
  ['空白だけ', '   '],
];
const MISSING_CASES = REQUIRED_NAMES.flatMap((name) =>
  MISSING_VALUES.map(([label, value]) => [name, label, value] as const),
);

const makeRequest = () =>
  new Request('http://localhost/api/shopping-list/regenerate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate: '2099-01-01', endDate: '2099-01-03' }),
  });

const loadRoute = () => import('@/app/api/shopping-list/regenerate/route');

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY);
  vi.stubGlobal('fetch', mockFetch);
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mockCheckRateLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60_000 });
  mockInsert.mockImplementation(() => ({
    select: () => ({ single: async () => ({ data: { id: REQUEST_ID }, error: null }) }),
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('POST /api/shopping-list/regenerate — 必須の環境変数を取り出す順序 (#1434)', () => {
  it.each(REQUIRED_NAMES)('%s が未設定でも、未ログインなら 401 を返す (設定の不足を教えず、DB にも触れない)', async (name) => {
    vi.stubEnv(name, undefined);
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const { POST } = await loadRoute();

    const response = await POST(makeRequest());
    const text = await response.text();

    expect(response.status).toBe(401);
    expect(text).not.toContain(name);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRecordAiUsage).not.toHaveBeenCalled();
  });

  it('必須の環境変数が未設定でも、レート制限を超えていれば 429 を返す (DB に触れない)', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', undefined);
    mockCheckRateLimit.mockResolvedValue({ success: false, limit: 10, remaining: 0, reset: Date.now() + 60_000 });
    const { POST } = await loadRoute();

    const response = await POST(makeRequest());

    expect(response.status).toBe(429);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRecordAiUsage).not.toHaveBeenCalled();
  });

  it.each(MISSING_CASES)(
    '%s が%sなら、AI 利用回数の記録・リクエストの行の作成より前に、汎用の 500 で止める (本文に変数名なし・ログに変数名あり)',
    async (name, _label, value) => {
      vi.stubEnv(name, value);
      const { POST } = await loadRoute();

      const response = await POST(makeRequest());
      const text = await response.text();

      expect(response.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
      expect(text).not.toContain(name);
      expect(JSON.stringify([...response.headers.entries()])).not.toContain(name);
      // 変数名は構造化ログに渡す
      expect(mockLoggerError).toHaveBeenCalledTimes(1);
      expect(mockLoggerError.mock.calls[0][1]).toMatchObject({ name: 'MissingEnvError', envName: name });
      expect(mockCheckRateLimit).toHaveBeenCalledWith('user-1', 'generation');
      // DB に何も書かない (processing のまま残る行を作らない)
      expect(mockRecordAiUsage).not.toHaveBeenCalled();
      expect(mockFrom).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it('設定が揃っていれば、記録・行の作成のあとで、取り出した接続情報で Edge Function を呼ぶ', async () => {
    const { POST } = await loadRoute();

    const response = await POST(makeRequest());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ requestId: REQUEST_ID, message: '再生成を開始しました' });
    expect(mockLoggerError).not.toHaveBeenCalled();
    expect(mockRecordAiUsage).toHaveBeenCalledWith('user-1', 'shopping_list');
    expect(mockFrom).toHaveBeenCalledWith('shopping_list_requests');
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert.mock.calls[0][0]).toMatchObject({ user_id: 'user-1', status: 'processing' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${SUPABASE_URL}/functions/v1/regenerate-shopping-list-v2`);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${SERVICE_ROLE_KEY}`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ requestId: REQUEST_ID, userId: 'user-1' });
  });
});

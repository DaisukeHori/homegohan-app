/**
 * tests/api/comparison-trigger-route.test.ts
 *
 * #1406: POST /api/comparison/trigger (セグメント統計の集計を手動で走らせる API)
 *
 * 修正前:
 *   - ログインしていれば誰でも呼べた (getUser() しか見ていなかった)
 *   - 利用者の JWT のまま Edge Function calculate-segment-stats を呼んでいたため、関数の認証
 *     (requireServiceRole: service role の鍵か CRON_SECRET しか通さない) で必ず 401 になり、この API は必ず 500 だった
 *   - 失敗時に error.message をそのまま本文に返していた (#1172)
 *
 * このテストが守るもの:
 *   - 未ログインは 401、super_admin でない利用者 (一般・admin・support・凍結中) は 403。どちらも関数を呼ばない
 *   - 許可するロールは super_admin だけ (requireRole に渡すロール)
 *   - super_admin なら、関数を service role の鍵 (Bearer) で呼び、本文には periodType だけを渡す
 *     (期間の開始日などを本文に書いても渡さない = 関数は直近の 1 期間だけを集計する)
 *   - periodType は daily / weekly / monthly のどれか。省略・空の本文は weekly。それ以外・壊れた JSON は 400 で関数を呼ばない
 *   - 関数の失敗・通信の失敗・設定の不足は 500 で、本文は汎用メッセージだけ (関数が返した文面や原因は出さない)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthError, ForbiddenError } from '../../src/lib/auth/errors';
import { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from '../../src/lib/api/errors';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: mocks.requireRole,
}));

// internalError() の構造化ログ (app_logs への書き込み) を差し替える
vi.mock('@/lib/db-logger', () => {
  const logger = {
    error: mocks.loggerError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    withUser: () => logger,
  };
  return {
    createLogger: () => logger,
    generateRequestId: () => 'req_test',
  };
});

import { POST } from '../../src/app/api/comparison/trigger/route';

const SUPABASE_URL = 'https://example-project.supabase.co';
const SERVICE_ROLE_KEY = 'test-service-role-key';
const EDGE_URL = `${SUPABASE_URL}/functions/v1/calculate-segment-stats`;
const SUPER_ADMIN = { id: 'super-admin-1', email: 'sa@example.com', roles: ['user', 'super_admin'], organization_id: null };

/** 関数が成功したときに返す本文 (supabase/functions/calculate-segment-stats/index.ts の 200 の形) */
const EDGE_OK_BODY = {
  success: true,
  processedUsers: 12,
  processedSegments: 3,
  periodType: 'weekly',
  periodStart: '2026-10-05',
  periodEnd: '2026-10-11',
};

const fetchMock = vi.fn();

function request(body?: unknown, raw?: string): Request {
  return new Request('http://localhost/api/comparison/trigger', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** fetch に渡された (URL, 初期化) */
function fetchCall(index = 0): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url: String(url), init };
}

function expectGenericInternalError(json: unknown) {
  expect(json).toEqual({ error: { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE } });
}

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.loggerError.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/comparison/trigger: 呼べるのは super_admin だけ (#1406)', () => {
  it('許可するロールは super_admin だけ (admin / support / 一般利用者は含めない)', async () => {
    mocks.requireRole.mockResolvedValue(SUPER_ADMIN);
    fetchMock.mockResolvedValue(jsonResponse(200, EDGE_OK_BODY));

    await POST(request({ periodType: 'weekly' }));

    expect(mocks.requireRole).toHaveBeenCalledTimes(1);
    expect(mocks.requireRole).toHaveBeenCalledWith(['super_admin']);
  });

  it('未ログインは 401 で、関数を呼ばない', async () => {
    mocks.requireRole.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));

    const res = await POST(request({ periodType: 'weekly' }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: '認証が必要です' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['ロールが足りない (一般利用者・admin・support)', new ForbiddenError('PERM_DENIED', 'Requires one of: super_admin')],
    ['アカウントが凍結中', new ForbiddenError('AUTH_ACCOUNT_FROZEN', 'アカウントが凍結されています')],
  ])('%s は 403 で、関数を呼ばない', async (_label, error) => {
    mocks.requireRole.mockRejectedValue(error);

    const res = await POST(request({ periodType: 'weekly' }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'FORBIDDEN', message: '権限がありません' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('認可の確認そのものが想定外の例外で失敗したら 500 (汎用メッセージ) で、関数を呼ばない', async () => {
    mocks.requireRole.mockRejectedValue(new Error('relation "user_profiles" does not exist'));

    const res = await POST(request({ periodType: 'weekly' }));

    expect(res.status).toBe(500);
    expectGenericInternalError(await res.json());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/comparison/trigger: 関数の呼び方 (#1406)', () => {
  beforeEach(() => {
    mocks.requireRole.mockResolvedValue(SUPER_ADMIN);
  });

  it.each(['daily', 'weekly', 'monthly'] as const)(
    'periodType=%s: service role の鍵で関数を 1 回呼び、関数の結果をそのまま返す',
    async (periodType) => {
      const edgeBody = { ...EDGE_OK_BODY, periodType };
      fetchMock.mockResolvedValue(jsonResponse(200, edgeBody));

      const res = await POST(request({ periodType }));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(edgeBody);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { url, init } = fetchCall();
      expect(url).toBe(EDGE_URL);
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${SERVICE_ROLE_KEY}`);
      expect(JSON.parse(String(init.body))).toEqual({ periodType });
    },
  );

  it('期間の開始日・埋め戻しの指定などを本文に書いても、関数には periodType だけを渡す (直近の 1 期間だけを集計させる)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, EDGE_OK_BODY));

    const res = await POST(
      request({ periodType: 'monthly', periodStart: '2025-01-01', periodEnd: '2025-01-31', forceRecalc: true, backfill: 12 }),
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(String(fetchCall().init.body))).toEqual({ periodType: 'monthly' });
  });

  it.each([
    ['periodType を省略', request({})],
    ['本文が空', request()],
  ])('%s したときは weekly で呼ぶ (関数の既定と同じ)', async (_label, req) => {
    fetchMock.mockResolvedValue(jsonResponse(200, EDGE_OK_BODY));

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(JSON.parse(String(fetchCall().init.body))).toEqual({ periodType: 'weekly' });
  });

  it.each([
    ['対応していない periodType (all_time)', request({ periodType: 'all_time' })],
    ['対応していない periodType (任意の文字列)', request({ periodType: 'yearly' })],
    ['periodType が文字列でない', request({ periodType: 7 })],
    ['本文が JSON として読めない', request(undefined, '{"periodType": ')],
    ['本文が配列', request(['weekly'])],
  ])('%s は 400 で、関数を呼ばない', async (_label, req) => {
    const res = await POST(req);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(json.error.message).toBe('periodType は daily / weekly / monthly のいずれかを指定してください');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/comparison/trigger: 失敗しても原因を本文に出さない (#1172 / #1406)', () => {
  beforeEach(() => {
    mocks.requireRole.mockResolvedValue(SUPER_ADMIN);
  });

  it.each([401, 500, 503])('関数が HTTP %i を返したら 500 (汎用メッセージ)。関数の本文はログにだけ残す', async (status) => {
    const leaked = 'user_segment_rankings の保存: duplicate key value violates unique constraint user_segment_rankings_pkey';
    fetchMock.mockResolvedValue(jsonResponse(status, { error: leaked }));

    const res = await POST(request({ periodType: 'weekly' }));

    expect(res.status).toBe(500);
    const json = await res.json();
    expectGenericInternalError(json);
    expect(JSON.stringify(json)).not.toContain('user_segment_rankings');

    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    const [, loggedError, metadata] = mocks.loggerError.mock.calls[0] as [string, Error, Record<string, unknown>];
    expect(loggedError.message).toContain(`HTTP ${status}`);
    expect(loggedError.message).toContain(leaked);
    expect(metadata).toMatchObject({ periodType: 'weekly', edge_status: status });
  });

  it('関数への通信そのものが失敗したら 500 (汎用メッセージ)', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed: getaddrinfo ENOTFOUND example-project.supabase.co'));

    const res = await POST(request({ periodType: 'weekly' }));

    expect(res.status).toBe(500);
    const json = await res.json();
    expectGenericInternalError(json);
    expect(JSON.stringify(json)).not.toContain('ENOTFOUND');
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
  });

  it('関数の成功の本文が JSON でなければ 500 (汎用メッセージ)', async () => {
    fetchMock.mockResolvedValue(new Response('<html>gateway</html>', { status: 200 }));

    const res = await POST(request({ periodType: 'weekly' }));

    expect(res.status).toBe(500);
    expectGenericInternalError(await res.json());
  });

  it.each(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])(
    '%s が未設定なら、関数を呼ばずに 500 (汎用メッセージ)',
    async (name) => {
      vi.stubEnv(name, '');

      const res = await POST(request({ periodType: 'weekly' }));

      expect(res.status).toBe(500);
      expectGenericInternalError(await res.json());
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    },
  );
});

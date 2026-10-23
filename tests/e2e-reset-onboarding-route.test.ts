// @vitest-environment node
/**
 * POST /api/e2e/reset-onboarding (E2E の道具が呼ぶ。Maestro の apps/mobile/maestro/flows/scripts/reset-onboarding.js) の失敗の本文 (#1917)
 *
 * 失敗の本文の文は日本語の固定の文にする (以前は 'Not available in production' / 'Unauthorized' の英語の文)。
 * 本文の形 ({ error: '<文>' }) と状態 (403 / 401) は従来のまま。本番では DB に触れない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { isEnglishOnly } from './helpers/api-error-text-scan';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockCreateClient = vi.fn(async () => ({ auth: { getUser: mockGetUser }, from: mockFrom }));

vi.mock('@/lib/supabase/server', () => ({ createClient: () => mockCreateClient() }));

const { POST } = await import('@/app/api/e2e/reset-onboarding/route');

const HTTP_FORBIDDEN = 403;
const HTTP_UNAUTHORIZED = 401;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/e2e/reset-onboarding の失敗の本文', () => {
  it('本番では 403 で「本番環境では使えません」。ログインの確認も DB の更新もしない', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    const res = await POST();

    expect(res.status).toBe(HTTP_FORBIDDEN);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: '本番環境では使えません' });
    expect(isEnglishOnly(body.error)).toBe(false);
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it.each([
    ['ログインしていない', { data: { user: null }, error: null }],
    ['セッションの確認に失敗した (英語の文面つき)', { data: { user: null }, error: { message: 'Auth session missing!' } }],
  ])('%s: 401 で「ログインが必要です」(例外の文面は出さない)。DB は更新しない', async (_label, result) => {
    vi.stubEnv('NODE_ENV', 'test');
    mockGetUser.mockResolvedValue(result);

    const res = await POST();

    expect(res.status).toBe(HTTP_UNAUTHORIZED);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: API_UNAUTHENTICATED_MESSAGE });
    expect(API_UNAUTHENTICATED_MESSAGE).toBe('ログインが必要です');
    expect(text).not.toContain('Auth session missing!');
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

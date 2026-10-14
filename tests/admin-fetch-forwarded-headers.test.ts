/**
 * #1200 adminFetch (src/lib/admin/fetch.ts) のヘッダー転送テスト
 *
 * 管理画面のサーバーコンポーネントは adminFetch で内部 API (GET /api/admin/users/{id} など) を呼ぶ。
 * 閲覧の監査ログ (admin_audit_logs.ip_address / user_agent) に管理者本人の情報が残るよう、
 * 元のリクエストの x-forwarded-for と user-agent を内部 API へ転送することを確認する。
 * (転送しないと user-agent はサーバー側 fetch の既定値になり、誰が見たかの手がかりにならない)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let incomingHeaders: Record<string, string> = {};

vi.mock('next/headers', () => ({
  headers: async () => new Headers(incomingHeaders),
  cookies: () => ({ getAll: () => [{ name: 'sb-access-token', value: 'session-value' }] }),
}));

const fetchMock = vi.fn(async (..._args: unknown[]) => new Response('{}'));

const { adminFetch } = await import('@/lib/admin/fetch');

function sentHeaders(): Record<string, string> {
  const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
  return init.headers;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('adminFetch: 監査ログ用のヘッダー転送', () => {
  it('元のリクエストの x-forwarded-for と user-agent、Cookie を内部 API へ転送する', async () => {
    incomingHeaders = {
      'x-forwarded-for': '203.0.113.7',
      'user-agent': 'Mozilla/5.0 (AdminBrowser)',
      host: 'app.example.com',
    };

    await adminFetch('/api/admin/users/abc');

    const headers = sentHeaders();
    expect(headers['x-forwarded-for']).toBe('203.0.113.7');
    expect(headers['user-agent']).toBe('Mozilla/5.0 (AdminBrowser)');
    expect(headers.host).toBe('app.example.com');
    expect(headers.Cookie).toBe('sb-access-token=session-value');
  });

  it('user-agent が無いリクエストでは user-agent を付けない', async () => {
    incomingHeaders = { 'x-forwarded-for': '203.0.113.7' };

    await adminFetch('/api/admin/users/abc');

    expect(sentHeaders()).not.toHaveProperty('user-agent');
  });
});

/**
 * src/lib/auth/sessions/client.ts (Web の通信の薄い包み) の単体テスト
 * (#1189・#1190。設計 docs/design/cross/16-auth-history-sessions.md §15・§20.1)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSIONS_CLIENT_NETWORK_ERROR,
  SESSIONS_CLIENT_NO_STATUS,
  SESSIONS_CLIENT_UNKNOWN_CODE,
  SESSIONS_NETWORK_ERROR_MESSAGE,
  SESSIONS_UNKNOWN_ERROR_MESSAGE,
  listLoginHistory,
  listSessions,
  revokeOtherSessions,
  revokeSession,
} from '@/lib/auth/sessions/client';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const baseRow = {
  session_id: SESSION_ID,
  created_at: '2026-10-15T01:00:00.000000+00:00',
  last_active_at: '2026-10-15T02:00:00.000000+00:00',
  device_label: 'Windows の Chrome',
  device_name: null,
  ip_address: '203.0.113.10',
  country_code: 'JP',
};
const summary = { ...baseRow, is_current: true };
const historyEntry = {
  ...baseRow,
  ended_at: null,
  ended_reason: null,
  is_new_device: true,
  is_new_ip: false,
  is_new_country: false,
  alert_sent_at: null,
};

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sessions/client.ts (§15)', () => {
  it('listSessions は GET /api/auth/sessions を呼び、応答を SessionsResponseSchema で検証して返す', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessions: [summary] }));
    const result = await listSessions();
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/sessions', expect.objectContaining({ method: 'GET', cache: 'no-store' }));
    expect(result).toEqual({ ok: true, data: [summary] });
  });

  it('revokeSession(id) は DELETE /api/auth/sessions/{id}、revokeOtherSessions は POST /api/auth/sessions/revoke-others、listLoginHistory は GET /api/auth/login-history を呼ぶ', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(revokeSession(SESSION_ID)).resolves.toEqual({ ok: true, data: { ok: true } });
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/auth/sessions/${SESSION_ID}`, expect.objectContaining({ method: 'DELETE' }));

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, remaining: 1 }));
    await expect(revokeOtherSessions()).resolves.toEqual({ ok: true, data: { ok: true, remaining: 1 } });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/auth/sessions/revoke-others', expect.objectContaining({ method: 'POST' }));

    const entry = { ...historyEntry };
    fetchMock.mockResolvedValueOnce(jsonResponse({ entries: [entry] }));
    const history = await listLoginHistory();
    expect(fetchMock).toHaveBeenLastCalledWith('/api/auth/login-history', expect.objectContaining({ method: 'GET' }));
    expect(history.ok).toBe(true);
    expect(history.ok && history.data).toEqual([entry]);
  });

  it('4xx / 5xx の本文の code と error を { code, message } にして返す', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'いま使っている端末は、ここでは解除できません。ログアウトを使ってください。', code: 'AUTH_SESSION_IS_CURRENT' }, 409),
    );
    await expect(revokeSession(SESSION_ID)).resolves.toEqual({
      ok: false,
      status: 409,
      error: { code: 'AUTH_SESSION_IS_CURRENT', message: 'いま使っている端末は、ここでは解除できません。ログアウトを使ってください。' },
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' }, 500));
    await expect(listSessions()).resolves.toEqual({
      ok: false,
      status: 500,
      error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました' },
    });

    // 本文が JSON でない (読めない) ときは既定の code と文
    fetchMock.mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }));
    await expect(listSessions()).resolves.toEqual({
      ok: false,
      status: 502,
      error: { code: SESSIONS_CLIENT_UNKNOWN_CODE, message: SESSIONS_UNKNOWN_ERROR_MESSAGE },
    });
  });

  it('応答が Zod に合わなければ、生の本文を出さずに失敗として返す', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [{ ...summary, session_id: 'not-a-uuid <script>' }] }));
    const result = await listSessions();
    expect(result).toEqual({
      ok: false,
      status: 200,
      error: { code: SESSIONS_CLIENT_UNKNOWN_CODE, message: SESSIONS_UNKNOWN_ERROR_MESSAGE },
    });
    expect(JSON.stringify(result)).not.toContain('<script>');
  });

  it('fetch の reject は通信エラーの { code, message } にする', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(revokeOtherSessions()).resolves.toEqual({
      ok: false,
      status: SESSIONS_CLIENT_NO_STATUS,
      error: { code: SESSIONS_CLIENT_NETWORK_ERROR, message: SESSIONS_NETWORK_ERROR_MESSAGE },
    });
  });
});

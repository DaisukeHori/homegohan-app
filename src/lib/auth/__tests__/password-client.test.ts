/**
 * src/lib/auth/password/client.ts (Web の通信の薄い包み) の単体テスト
 * (#1198。設計 docs/design/cross/16-auth-history-sessions.md §15・§20.1)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PASSWORD_CLIENT_NETWORK_ERROR,
  PASSWORD_CLIENT_NO_STATUS,
  PASSWORD_CLIENT_UNKNOWN_CODE,
  PASSWORD_NETWORK_ERROR_MESSAGE,
  changePassword,
  resetPassword,
} from '@/lib/auth/password/client';

const CURRENT_PASSWORD = 'CurrentPass2026x';
const NEW_PASSWORD = 'NewPass2026x';

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

describe('password/client.ts (§15)', () => {
  it('changePassword は POST /api/auth/password/change に { current_password, new_password } を JSON で送る', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const result = await changePassword({ current_password: CURRENT_PASSWORD, new_password: NEW_PASSWORD });
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/auth/password/change');
    expect(init).toEqual(expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store' }));
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ current_password: CURRENT_PASSWORD, new_password: NEW_PASSWORD });
  });

  it('resetPassword は POST /api/auth/password/reset に { new_password } だけを送る', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const result = await resetPassword({ new_password: NEW_PASSWORD });
    expect(result).toEqual({ ok: true });
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/auth/password/reset');
    expect(JSON.parse(String(init.body))).toEqual({ new_password: NEW_PASSWORD });
  });

  it.each([
    [400, 'AUTH_CURRENT_PASSWORD_MISMATCH', '現在のパスワードが正しくありません。'],
    [403, 'AUTH_REAUTHENTICATION_REQUIRED', '安全のため、もう一度ログインしてから変更してください。'],
    [409, 'AUTH_PASSWORD_NOT_SET', 'このアカウントはパスワードでログインしていないため、変更できません。'],
    [422, 'VALID_PASSWORD_HISTORY', '最近使ったパスワードは使えません。別のパスワードにしてください。'],
    [429, 'RATE_LIMITED', 'リクエストが多すぎます。しばらく時間をおいてからお試しください。'],
    [500, 'INTERNAL_ERROR', 'サーバーでエラーが発生しました。'],
  ])('%i %s は本文の code と error を { code, message } にして返す', async (status, code, error) => {
    fetchMock.mockResolvedValue(jsonResponse({ error, code }, status));
    const result = await changePassword({ current_password: CURRENT_PASSWORD, new_password: NEW_PASSWORD });
    expect(result).toEqual({ ok: false, status, error: { code, message: error } });
  });

  it('本文が JSON でない失敗は code UNKNOWN・message null で返す (生の本文を出さない)', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));
    const result = await resetPassword({ new_password: NEW_PASSWORD });
    expect(result).toEqual({ ok: false, status: 502, error: { code: PASSWORD_CLIENT_UNKNOWN_CODE, message: null } });
  });

  it('2xx でも本文が { ok: true } でなければ成功と見なさない', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ something: 'else' }));
    const result = await changePassword({ current_password: CURRENT_PASSWORD, new_password: NEW_PASSWORD });
    expect(result).toEqual({ ok: false, status: 200, error: { code: PASSWORD_CLIENT_UNKNOWN_CODE, message: null } });
  });

  it('fetch の reject は通信エラーの { code, message } にする (例外を投げない)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await changePassword({ current_password: CURRENT_PASSWORD, new_password: NEW_PASSWORD });
    expect(result).toEqual({
      ok: false,
      status: PASSWORD_CLIENT_NO_STATUS,
      error: { code: PASSWORD_CLIENT_NETWORK_ERROR, message: PASSWORD_NETWORK_ERROR_MESSAGE },
    });
  });

  it('戻り値・例外にパスワードを含めない (成功・失敗・通信エラーのどれでも)', async () => {
    const outcomes = [] as unknown[];
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    outcomes.push(await changePassword({ current_password: CURRENT_PASSWORD, new_password: NEW_PASSWORD }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: '現在のパスワードが正しくありません。', code: 'AUTH_CURRENT_PASSWORD_MISMATCH' }, 400));
    outcomes.push(await changePassword({ current_password: CURRENT_PASSWORD, new_password: NEW_PASSWORD }));
    fetchMock.mockRejectedValueOnce(new TypeError(`Failed to fetch ${CURRENT_PASSWORD}`));
    outcomes.push(await resetPassword({ new_password: NEW_PASSWORD }));
    const text = JSON.stringify(outcomes);
    expect(text).not.toContain(CURRENT_PASSWORD);
    expect(text).not.toContain(NEW_PASSWORD);
  });
});

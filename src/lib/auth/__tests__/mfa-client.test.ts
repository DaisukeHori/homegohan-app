/**
 * #1176 運営ロールの MFA の画面の通信の facade のテスト (段 A・段 B・段 C)。docs/design/cross/12-operator-mfa.md §15.1・§21.1 (mfa-client.test.ts)
 * fetch を vi.stubGlobal で差し替える。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MFA_API_PATHS,
  MFA_CLIENT_NO_STATUS,
  MFA_CLIENT_UNKNOWN_CODE,
  MFA_FALLBACK_ERROR_MESSAGE,
  getMfaStatus,
  mfaErrorMessage,
  mfaFactorPath,
  mfaResetPath,
  recoverWithBackupCode,
  regenerateBackupCodes,
  requestMfaApi,
  resetOperatorMfa,
  startMfaEnrollment,
  unenrollMfaFactor,
  verifyMfaCode,
} from '@/lib/auth/mfa/client';
import { MfaRecoverResponseSchema } from '@/lib/auth/mfa/schemas';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const NO_RESPONSE = { ok: false, status: MFA_CLIENT_NO_STATUS, code: MFA_CLIENT_UNKNOWN_CODE, retryAfterSec: null };
const RECOVER_OK = { ok: true, next: '/login?next=%2Fsettings%2Fsecurity%2Fmfa%2Fsetup' };
const FACTOR_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestMfaApi', () => {
  it('requestMfaApi: 2xx で本文が schema に合えば { ok: true, data }', async () => {
    fetchMock.mockResolvedValue(jsonResponse(RECOVER_OK, 200));
    await expect(requestMfaApi('/api/x', { method: 'POST' }, MfaRecoverResponseSchema)).resolves.toEqual({
      ok: true,
      data: RECOVER_OK,
    });
  });

  it('requestMfaApi: 2xx でも本文が JSON でない・schema に合わなければ { ok: false, status: MFA_CLIENT_NO_STATUS, code: MFA_CLIENT_UNKNOWN_CODE, retryAfterSec: null }', async () => {
    fetchMock.mockResolvedValue(new Response('<html>error</html>', { status: 200 }));
    await expect(requestMfaApi('/api/x', { method: 'GET' }, MfaRecoverResponseSchema)).resolves.toEqual(NO_RESPONSE);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }, 200));
    await expect(requestMfaApi('/api/x', { method: 'GET' }, MfaRecoverResponseSchema)).resolves.toEqual(NO_RESPONSE);
  });

  it('requestMfaApi: 4xx / 5xx は status と本文の code を返す (flat の { error, code } と nested の { error: { code, message } } の両方)。code が読めなければ MFA_CLIENT_UNKNOWN_CODE', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: '確認コードが違います', code: 'AUTH_2FA_INVALID' }, 400));
    await expect(requestMfaApi('/api/x', { method: 'POST' }, MfaRecoverResponseSchema)).resolves.toEqual({
      ok: false,
      status: 400,
      code: 'AUTH_2FA_INVALID',
      retryAfterSec: null,
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'OP_SELF_MODIFY', message: 'no' } }, 403));
    await expect(requestMfaApi('/api/x', { method: 'POST' }, MfaRecoverResponseSchema)).resolves.toMatchObject({
      ok: false,
      status: 403,
      code: 'OP_SELF_MODIFY',
    });
    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 500 }));
    await expect(requestMfaApi('/api/x', { method: 'POST' }, MfaRecoverResponseSchema)).resolves.toEqual({
      ok: false,
      status: 500,
      code: MFA_CLIENT_UNKNOWN_CODE,
      retryAfterSec: null,
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'x', code: '' }, 409));
    await expect(requestMfaApi('/api/x', { method: 'POST' }, MfaRecoverResponseSchema)).resolves.toMatchObject({
      code: MFA_CLIENT_UNKNOWN_CODE,
    });
  });

  it('requestMfaApi: Retry-After ヘッダの秒を retryAfterSec に入れる (無い・0・負・数でないなら null)', async () => {
    const cases: Array<[Record<string, string>, number | null]> = [
      [{ 'Retry-After': '42' }, 42],
      [{}, null],
      [{ 'Retry-After': '0' }, null],
      [{ 'Retry-After': '-5' }, null],
      [{ 'Retry-After': 'soon' }, null],
    ];
    for (const [headers, expected] of cases) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'RATE_LIMITED' }, 429, headers));
      const result = await requestMfaApi('/api/x', { method: 'POST' }, MfaRecoverResponseSchema);
      expect(result, JSON.stringify(headers)).toEqual({ ok: false, status: 429, code: 'RATE_LIMITED', retryAfterSec: expected });
    }
  });

  it('requestMfaApi: fetch が例外を投げても、fetch の戻りが Response でなくても (テストの差し替えの漏れ)、例外にせず MFA_CLIENT_NO_STATUS の失敗を返す', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(requestMfaApi('/api/x', { method: 'GET' }, MfaRecoverResponseSchema)).resolves.toEqual(NO_RESPONSE);
    fetchMock.mockResolvedValueOnce(undefined);
    await expect(requestMfaApi('/api/x', { method: 'GET' }, MfaRecoverResponseSchema)).resolves.toEqual(NO_RESPONSE);
  });

  it('requestMfaApi: fetch に credentials: same-origin と cache: no-store を渡す', async () => {
    fetchMock.mockResolvedValue(jsonResponse(RECOVER_OK, 200));
    await requestMfaApi('/api/x', { method: 'POST', body: '{}' }, MfaRecoverResponseSchema);
    expect(fetchMock).toHaveBeenCalledWith('/api/x', {
      method: 'POST',
      body: '{}',
      credentials: 'same-origin',
      cache: 'no-store',
    });
  });
});

describe('段 A の 4 関数', () => {
  it('getMfaStatus / startMfaEnrollment / verifyMfaCode / recoverWithBackupCode は MFA_API_PATHS の status / enroll / verify / recover を GET / POST / POST / POST で呼び、verify と recover だけが JSON の本文 (Content-Type: application/json) を送る', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}, 500));
    await getMfaStatus();
    await startMfaEnrollment();
    await verifyMfaCode({ factor_id: FACTOR_ID, code: '123456' });
    await recoverWithBackupCode({ code: 'ABCDE-FGHJK' });

    expect(MFA_API_PATHS).toEqual({
      status: '/api/auth/mfa/status',
      enroll: '/api/auth/mfa/enroll',
      verify: '/api/auth/mfa/verify',
      recover: '/api/auth/mfa/recover',
      // 段 B (§14.4・§14.6)
      backupCodes: '/api/auth/mfa/backup-codes',
      factors: '/api/auth/mfa/factors',
      // 段 C (§14.7)
      superAdminAdmins: '/api/super-admin/admins',
    });
    const calls = fetchMock.mock.calls.map((call) => {
      const [path, init] = call as [string, RequestInit];
      return { path, method: init.method, headers: init.headers, body: init.body };
    });
    expect(calls).toEqual([
      { path: '/api/auth/mfa/status', method: 'GET', headers: undefined, body: undefined },
      { path: '/api/auth/mfa/enroll', method: 'POST', headers: undefined, body: undefined },
      {
        path: '/api/auth/mfa/verify',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ factor_id: FACTOR_ID, code: '123456' }),
      },
      {
        path: '/api/auth/mfa/recover',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'ABCDE-FGHJK' }),
      },
    ]);
  });

  it('getMfaStatus は 200 の本文を MfaStatusResponseSchema で読み、形が違えば失敗にする', async () => {
    const status = {
      ok: true,
      required: true,
      enrolled: true,
      aal: 'aal1',
      factor: { id: FACTOR_ID, friendly_name: 'authenticator', created_at: '2026-10-01T00:00:00Z' },
      backup_codes_remaining: 9,
      enforce_from: null,
      grace: false,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(status, 200));
    await expect(getMfaStatus()).resolves.toEqual({ ok: true, data: status });
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...status, backup_codes_remaining: -1 }, 200));
    await expect(getMfaStatus()).resolves.toEqual(NO_RESPONSE);
  });
});

describe('段 B の 2 関数', () => {
  it('regenerateBackupCodes は POST /api/auth/mfa/backup-codes、unenrollMfaFactor は DELETE /api/auth/mfa/factors/<encodeURIComponent(id)> を本文なしで呼ぶ', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}, 500));
    const oddId = 'factor/../x?y';
    await regenerateBackupCodes();
    await unenrollMfaFactor(oddId);
    const calls = fetchMock.mock.calls.map((call) => {
      const [path, init] = call as [string, RequestInit];
      return { path, method: init.method, headers: init.headers, body: init.body };
    });
    expect(calls).toEqual([
      { path: '/api/auth/mfa/backup-codes', method: 'POST', headers: undefined, body: undefined },
      { path: `/api/auth/mfa/factors/${encodeURIComponent(oddId)}`, method: 'DELETE', headers: undefined, body: undefined },
    ]);
    expect(mfaFactorPath('abc')).toBe('/api/auth/mfa/factors/abc');
  });

  it('regenerateBackupCodes / unenrollMfaFactor は 200 の本文を MfaBackupCodesResponseSchema / MfaUnenrollResponseSchema で読み、形が違えば失敗にする', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, backup_codes: ['ABCDE-FGHJK'] }, 200));
    await expect(regenerateBackupCodes()).resolves.toEqual({ ok: true, data: { ok: true, backup_codes: ['ABCDE-FGHJK'] } });
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, aal: 'aal2' }, 200));
    await expect(unenrollMfaFactor('f-1')).resolves.toEqual({ ok: true, data: { ok: true, aal: 'aal2' } });
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, aal: 'aal3' }, 200));
    await expect(unenrollMfaFactor('f-1')).resolves.toMatchObject({ ok: false, status: MFA_CLIENT_NO_STATUS });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'x', code: 'AUTH_2FA_REQUIRED' }, 403));
    await expect(regenerateBackupCodes()).resolves.toMatchObject({ ok: false, status: 403, code: 'AUTH_2FA_REQUIRED' });
  });
});

describe('段 C の関数', () => {
  const RESET_BODY = { reason: '端末の紛失 (ビデオ通話で本人を確認)', identity_check: 'video_call', identity_confirmed: true } as const;
  /** encodeURIComponent が効くことを見るための、区切りを含む id */
  const ODD_USER_ID = 'a/b?c';

  it('resetOperatorMfa は POST /api/super-admin/admins/<encodeURIComponent(userId)>/mfa/reset を JSON の本文で呼び、成功は data.data の 3 つの値、失敗は nested の本文の code (OP_SELF_MODIFY など)', async () => {
    expect(MFA_API_PATHS.superAdminAdmins).toBe('/api/super-admin/admins');
    expect(mfaResetPath(ODD_USER_ID)).toBe('/api/super-admin/admins/a%2Fb%3Fc/mfa/reset');

    const data = { user_id: FACTOR_ID, factors_deleted: 1, backup_codes_deleted: 10 };
    fetchMock.mockResolvedValueOnce(jsonResponse({ data }, 200));
    await expect(resetOperatorMfa(FACTOR_ID, RESET_BODY)).resolves.toEqual({ ok: true, data: { data } });
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/super-admin/admins/${FACTOR_ID}/mfa/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(RESET_BODY),
      credentials: 'same-origin',
      cache: 'no-store',
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'OP_SELF_MODIFY', message: '自分自身' } }, 403));
    await expect(resetOperatorMfa(ODD_USER_ID, RESET_BODY)).resolves.toEqual({
      ok: false,
      status: 403,
      code: 'OP_SELF_MODIFY',
      retryAfterSec: null,
    });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/super-admin/admins/a%2Fb%3Fc/mfa/reset');

    // 200 でも MfaResetResponseSchema の形でなければ失敗 (factors_deleted が負)
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { ...data, factors_deleted: -1 } }, 200));
    await expect(resetOperatorMfa(FACTOR_ID, RESET_BODY)).resolves.toEqual(NO_RESPONSE);
  });
});

describe('mfaErrorMessage', () => {
  it('mfaErrorMessage は §15 の文言の表の code の文を返し、表に無い code (UNKNOWN・INTERNAL_ERROR・constructor・toString を含む) は MFA_FALLBACK_ERROR_MESSAGE', () => {
    const table: Record<string, string> = {
      AUTH_2FA_INVALID: '確認コードが正しくありません。認証アプリの最新のコードを入力してください。',
      RATE_LIMITED: '試行回数が多すぎます。しばらくしてから再度お試しください。',
      AUTH_2FA_NOT_ENROLLED: '認証アプリが登録されていません。先に登録してください。',
      AUTH_2FA_ALREADY_ENROLLED: '認証アプリはすでに登録されています。変更するには先に解除してください。',
      AUTH_2FA_REQUIRED: 'この操作には二段階認証の確認が必要です。',
      PERM_DENIED: 'この画面は運営ロールの方だけが使えます。',
      AUTH_UNAUTHENTICATED: 'ログインが切れました。もう一度ログインしてください。',
      AUTH_2FA_NATIVE_SESSION:
        'アプリの中では、この画面で二段階認証の確認や解除ができません。アプリの確認画面か、ブラウザで行ってください。',
      UNAUTHORIZED: 'ログインが切れました。もう一度ログインしてください。',
      FORBIDDEN: 'この操作には運営最上位の権限と、二段階認証の確認が必要です。',
      OP_SELF_MODIFY: '自分自身の二段階認証は、ここでは解除できません。バックアップコードか、二段階認証の設定の画面で解除してください。',
      OP_INVALID_INPUT: '入力内容を確認してください (理由・本人確認の方法・確認のチェックが必要です)。',
      NOT_FOUND: '対象の利用者が見つかりません。',
    };
    for (const [code, message] of Object.entries(table)) {
      expect(mfaErrorMessage(code), code).toBe(message);
    }
    expect(MFA_FALLBACK_ERROR_MESSAGE).toBe('処理中にエラーが発生しました。しばらくしてからお試しください。');
    for (const code of [MFA_CLIENT_UNKNOWN_CODE, 'INTERNAL_ERROR', 'VALIDATION_ERROR', 'constructor', 'toString', '__proto__']) {
      expect(mfaErrorMessage(code), code).toBe(MFA_FALLBACK_ERROR_MESSAGE);
    }
  });
});

// @vitest-environment node
/**
 * #1917 の続き (整合 1025b): 運営の画面が 403 の本文の理由の文 (二段階認証の確認・登録が要る・凍結) を、
 * 画面の固定の文 (「権限がありません」など) で上書きしないための部品のテスト
 *
 * 以前は、運営の route が二段階認証の未完了の 403 に二段階認証の文を入れても (#2014 の operatorForbiddenMessageOf)、
 * プランの詳細の画面の読み直しや営業リード・問い合わせなどの画面は 403 を固定の「権限がありません」にしていて、
 * 二段階認証が要るのに権限が無いように見えた。
 *
 * 直したあとの不変条件:
 *   - forbiddenMessageForScreen は、本文の文が理由の文ならその文、それ以外 (ロールが足りない・英語の文・形が違う・読めない) は fallback
 *   - 理由の文の集合は、サーバーが 403 に入れる理由の文 (operatorForbiddenMessageOf・authFailureNested / authFailureFlat の既定の表) と一致する
 *     (サーバーの文を変えたのに画面の集合が古いまま、を見つける)
 */
import { describe, expect, it } from 'vitest';
import { ForbiddenError, MfaRequiredError } from '@/lib/auth/errors';
import {
  FORBIDDEN_SCREEN_MESSAGE,
  forbiddenMessageForScreen,
  forbiddenMessageOfResponse,
  operationFailureMessage,
  operationNetworkFailureMessage,
} from '@/lib/admin/api-error-message';
import { SUPER_ADMIN_ONLY_NOTE } from '@/lib/admin/operator-role-labels';
import {
  API_ACCOUNT_FROZEN_MESSAGE,
  API_FORBIDDEN_MESSAGE,
  API_MFA_ENROLLMENT_REQUIRED_MESSAGE,
  API_MFA_REQUIRED_MESSAGE,
  API_OP_PERMISSION_DENIED_MESSAGE,
  forbiddenMessageOf,
  operatorForbiddenMessageOf,
} from '@/lib/api/error-responses';
import { FORBIDDEN_REASON_MESSAGES } from '@/lib/api/forbidden-reason-messages';

const SCREEN_FALLBACK = `この画面を見る権限がありません (${SUPER_ADMIN_ONLY_NOTE})`;

const nested = (message: unknown) => ({ error: { code: 'OP_PERMISSION_DENIED', message } });

describe('forbiddenMessageForScreen (#1917)', () => {
  it.each([
    ['二段階認証の確認', API_MFA_REQUIRED_MESSAGE],
    ['二段階認証の登録', API_MFA_ENROLLMENT_REQUIRED_MESSAGE],
    ['凍結', API_ACCOUNT_FROZEN_MESSAGE],
  ])('本文 (nested) の文が理由の文 (%s) なら、その文をそのまま出す', (_label, message) => {
    expect(forbiddenMessageForScreen(nested(message))).toBe(message);
    expect(forbiddenMessageForScreen(nested(message), SCREEN_FALLBACK)).toBe(message);
  });

  it('本文 (flat) の文が理由の文でも、その文を出す (/api/announcements の形)', () => {
    expect(forbiddenMessageForScreen({ error: API_MFA_REQUIRED_MESSAGE })).toBe(API_MFA_REQUIRED_MESSAGE);
  });

  it.each([
    ['運営の route のロールが足りない文', nested(API_OP_PERMISSION_DENIED_MESSAGE)],
    ['既定の表のロールが足りない文', nested(API_FORBIDDEN_MESSAGE)],
    ['英語の文 (古い route)', nested('Requires one of: super_admin')],
    ['英語の code (flat)', { error: 'Forbidden' }],
    ['文が空', nested('')],
    ['文が文字列でない', nested(403)],
    ['本文が null (読めない)', null],
    ['本文の形が違う', { message: API_MFA_REQUIRED_MESSAGE }],
  ])('%s なら fallback を出す (既定は「権限がありません」)', (_label, body) => {
    expect(forbiddenMessageForScreen(body)).toBe(FORBIDDEN_SCREEN_MESSAGE);
    expect(FORBIDDEN_SCREEN_MESSAGE).toBe('権限がありません');
    expect(forbiddenMessageForScreen(body, SCREEN_FALLBACK)).toBe(SCREEN_FALLBACK);
  });
});

describe('forbiddenMessageOfResponse (#1917)', () => {
  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 403, headers: { 'content-type': 'application/json' } });

  it('403 の本文の理由の文を出す', async () => {
    await expect(forbiddenMessageOfResponse(jsonResponse(nested(API_MFA_REQUIRED_MESSAGE)))).resolves.toBe(API_MFA_REQUIRED_MESSAGE);
  });

  it('ロールが足りない文なら fallback (既定は「権限がありません」)', async () => {
    await expect(forbiddenMessageOfResponse(jsonResponse(nested(API_FORBIDDEN_MESSAGE)))).resolves.toBe('権限がありません');
    await expect(forbiddenMessageOfResponse(jsonResponse(nested(API_FORBIDDEN_MESSAGE)), SCREEN_FALLBACK)).resolves.toBe(
      SCREEN_FALLBACK,
    );
  });

  it('本文が JSON として読めなければ fallback (例外を投げない)', async () => {
    const html = new Response('<html>Forbidden</html>', { status: 403, headers: { 'content-type': 'text/html' } });
    await expect(forbiddenMessageOfResponse(html)).resolves.toBe('権限がありません');
  });
});

describe('理由の文の集合がサーバーの 403 の文と一致する (#1917)', () => {
  it('二段階認証の未完了 (確認・登録) の 403 の文は、運営の route の文も既定の表の文も、集合に入っている', () => {
    for (const code of ['AUTH_2FA_REQUIRED', 'AUTH_2FA_ENROLLMENT_REQUIRED'] as const) {
      const err = new MfaRequiredError(code);
      expect(FORBIDDEN_REASON_MESSAGES.has(operatorForbiddenMessageOf(err))).toBe(true);
      expect(FORBIDDEN_REASON_MESSAGES.has(forbiddenMessageOf(err))).toBe(true);
    }
  });

  it('凍結の 403 の文 (既定の表) は集合に入っている', () => {
    expect(FORBIDDEN_REASON_MESSAGES.has(forbiddenMessageOf(new ForbiddenError('AUTH_ACCOUNT_FROZEN')))).toBe(true);
  });

  it('ロールが足りない 403 の文は集合に入っていない (画面の固定の文を残す)', () => {
    expect(FORBIDDEN_REASON_MESSAGES.has(operatorForbiddenMessageOf(new ForbiddenError('PERM_DENIED')))).toBe(false);
    expect(FORBIDDEN_REASON_MESSAGES.has(forbiddenMessageOf(new ForbiddenError('PERM_DENIED')))).toBe(false);
  });

  it('集合は理由の文の 3 つだけ', () => {
    expect([...FORBIDDEN_REASON_MESSAGES].sort()).toEqual(
      [API_ACCOUNT_FROZEN_MESSAGE, API_MFA_ENROLLMENT_REQUIRED_MESSAGE, API_MFA_REQUIRED_MESSAGE].sort(),
    );
  });
});

describe('operationFailureMessage (運営の画面の操作の失敗の文)', () => {
  const SUMMARY = '一時停止できませんでした';

  it('403 の理由の文 (二段階認証の確認が要る) はそのまま理由に添える', () => {
    expect(operationFailureMessage(SUMMARY, 403, nested(API_MFA_REQUIRED_MESSAGE))).toBe(`${SUMMARY}（${API_MFA_REQUIRED_MESSAGE}）`);
  });

  it('403 の理由でない文 (英語の文など) は出さず「権限がありません」にする', () => {
    expect(operationFailureMessage(SUMMARY, 403, nested('Forbidden'))).toBe(`${SUMMARY}（${FORBIDDEN_SCREEN_MESSAGE}）`);
    expect(operationFailureMessage(SUMMARY, 403, null)).toBe(`${SUMMARY}（${FORBIDDEN_SCREEN_MESSAGE}）`);
  });

  it('403 でなければ本文の文を理由に添える (入れ子の形と flat の形のどちらでも)', () => {
    expect(operationFailureMessage(SUMMARY, 404, nested('クーポンが見つかりません'))).toBe(`${SUMMARY}（クーポンが見つかりません）`);
    expect(operationFailureMessage(SUMMARY, 500, { error: 'サーバーエラーが発生しました' })).toBe(
      `${SUMMARY}（サーバーエラーが発生しました）`,
    );
  });

  it('本文が読めなければ HTTP ステータスを添える', () => {
    expect(operationFailureMessage(SUMMARY, 502, null)).toBe(`${SUMMARY}（HTTP 502）`);
    expect(operationFailureMessage(SUMMARY, 500, { error: { code: 'X' } })).toBe(`${SUMMARY}（HTTP 500）`);
  });

  it('通信エラーは「通信エラー」を添える', () => {
    expect(operationNetworkFailureMessage(SUMMARY)).toBe(`${SUMMARY}（通信エラー）`);
  });
});

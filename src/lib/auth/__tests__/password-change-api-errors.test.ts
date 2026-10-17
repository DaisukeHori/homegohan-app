/**
 * packages/shared の describePasswordChangeApiError (パスワードの変更・再設定の API の失敗の文言) の単体テスト
 * (#1198。設計 docs/design/cross/16-auth-history-sessions.md §16・§19・§20.1)。Web とモバイルが同じ文を出す。
 */
import { describePasswordChangeApiError } from '@homegohan/shared';
import { describe, expect, it } from 'vitest';

const COMMON_FAILURE = 'パスワードを変更できませんでした。時間をおいて、もう一度お試しください。';

/** §19 の文言の列 (利用者向けの文) */
const SECTION_19_MESSAGES: Array<[string, string]> = [
  ['AUTH_CURRENT_PASSWORD_MISMATCH', '現在のパスワードが正しくありません。'],
  ['VALID_PASSWORD_HISTORY', '最近使ったパスワードは使えません。別のパスワードにしてください。'],
  ['AUTH_REAUTHENTICATION_REQUIRED', '安全のため、もう一度ログインしてから変更してください。'],
  ['AUTH_RECOVERY_SESSION_REQUIRED', 'パスワードの再設定は、再設定メールのリンクから開き直してください。'],
  ['AUTH_PASSWORD_NOT_SET', 'このアカウントはパスワードでログインしていないため、変更できません。'],
];

describe('describePasswordChangeApiError (§16)', () => {
  it('serverMessage (本文の error) が空でなければそれをそのまま返す', () => {
    expect(describePasswordChangeApiError('VALID_PASSWORD_WEAK', 'パスワードには数字を含めてください')).toBe('パスワードには数字を含めてください');
    // code が §19 の 5 つでも、serverMessage があればそちらを優先する
    expect(describePasswordChangeApiError('AUTH_CURRENT_PASSWORD_MISMATCH', 'サーバーが決めた文')).toBe('サーバーが決めた文');
    expect(describePasswordChangeApiError(null, '通信に失敗しました。')).toBe('通信に失敗しました。');
  });

  it.each(SECTION_19_MESSAGES)('serverMessage が null・空なら、%s は §19 の文言の列と同じ文を返す', (code, message) => {
    expect(describePasswordChangeApiError(code, null)).toBe(message);
    expect(describePasswordChangeApiError(code, '')).toBe(message);
    expect(describePasswordChangeApiError(code, '   ')).toBe(message);
  });

  it.each([
    ['VALID_PASSWORD_WEAK'],
    ['RATE_LIMITED'],
    ['AUTH_UNAUTHENTICATED'],
    ['INTERNAL_ERROR'],
    ['SOME_UNKNOWN_CODE'],
    ['toString'],
    ['constructor'],
    [null],
  ])('serverMessage が null・空で、それ以外の code (%s) は共通の失敗の文言', (code) => {
    expect(describePasswordChangeApiError(code, null)).toBe(COMMON_FAILURE);
    expect(describePasswordChangeApiError(code, '')).toBe(COMMON_FAILURE);
  });
});

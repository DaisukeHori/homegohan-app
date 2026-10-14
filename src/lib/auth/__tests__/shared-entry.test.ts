/**
 * Web の入口 (src/lib/auth の validate-password.ts・account-errors.ts・turnstile.ts) が、
 * packages/shared の同じ実体を公開していることのテスト (#1187)
 *
 * パスワードの規則・パスワード / メールアドレス変更のエラーの文言・CAPTCHA の判定は、モバイルと同じものを使うため
 * packages/shared に置いた。Web の既存の import 先はそのまま使えるよう、各ファイルは読み直すだけの入口にしている。
 * 入口に別の実装を書き足して、Web とモバイルの規則や文言が再び食い違わないよう、ここで同じ実体であることを固定する。
 */
import { describe, expect, it } from 'vitest';
import {
  CAPTCHA_FAILED_MESSAGE,
  PASSWORD_HINT_TEXT,
  PASSWORD_MIN_LENGTH,
  describeEmailChangeError,
  describePasswordChangeError,
  isCaptchaFailure,
  isNetworkAuthError,
  isRateLimitAuthError,
  isSessionExpiredAuthError,
  validatePassword,
} from '@homegohan/shared';
import * as webValidatePassword from '../validate-password';
import * as webAccountErrors from '../account-errors';
import * as webTurnstile from '../turnstile';

describe('Web の入口は、packages/shared の同じ実体を公開している', () => {
  it('パスワードの規則 (src/lib/auth/validate-password.ts)', () => {
    expect(webValidatePassword.validatePassword).toBe(validatePassword);
    expect(webValidatePassword.PASSWORD_MIN_LENGTH).toBe(PASSWORD_MIN_LENGTH);
    expect(webValidatePassword.PASSWORD_HINT_TEXT).toBe(PASSWORD_HINT_TEXT);
  });

  it('エラーの文言 (src/lib/auth/account-errors.ts)', () => {
    expect(webAccountErrors.describePasswordChangeError).toBe(describePasswordChangeError);
    expect(webAccountErrors.describeEmailChangeError).toBe(describeEmailChangeError);
    expect(webAccountErrors.isNetworkAuthError).toBe(isNetworkAuthError);
    expect(webAccountErrors.isRateLimitAuthError).toBe(isRateLimitAuthError);
    expect(webAccountErrors.isSessionExpiredAuthError).toBe(isSessionExpiredAuthError);
  });

  it('CAPTCHA の判定と文言 (src/lib/auth/turnstile.ts)', () => {
    expect(webTurnstile.isCaptchaFailure).toBe(isCaptchaFailure);
    expect(webTurnstile.CAPTCHA_FAILED_MESSAGE).toBe(CAPTCHA_FAILED_MESSAGE);
  });
});

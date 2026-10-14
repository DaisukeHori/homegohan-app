/**
 * src/lib/auth/account-errors.ts のユニットテスト
 * Issue #1187 — ログイン中のパスワード変更・メールアドレス変更で、Supabase Auth のエラーを日本語に直す。
 *
 * ここで使うエラーの形 (name / status / code / message) は、ローカルの Supabase Auth (GoTrue v2.183.0) が実際に返した値。
 *   現在のパスワードが違う       : AuthApiError 400 invalid_credentials  "Invalid login credentials"
 *   今のパスワードと同じ         : AuthApiError 422 same_password        "New password should be different from the old password."
 *   弱いパスワード               : AuthWeakPasswordError 422 weak_password (reasons: ['length'])
 *   使われているメールアドレス   : AuthApiError 422 email_exists         "A user with this email address has already been registered"
 *   不正な形式のメールアドレス   : AuthApiError 400 validation_failed    "Unable to validate email address: invalid format"
 *   確認メールの連続送信         : AuthApiError 429 over_email_send_rate_limit
 */

import { describe, expect, it } from 'vitest';
import {
  describeEmailChangeError,
  describePasswordChangeError,
  isNetworkAuthError,
  isRateLimitAuthError,
  isSessionExpiredAuthError,
} from '../account-errors';

const invalidCredentials = {
  name: 'AuthApiError',
  status: 400,
  code: 'invalid_credentials',
  message: 'Invalid login credentials',
};
const samePassword = {
  name: 'AuthApiError',
  status: 422,
  code: 'same_password',
  message: 'New password should be different from the old password.',
};
const weakPassword = {
  name: 'AuthWeakPasswordError',
  status: 422,
  code: 'weak_password',
  message: 'Password should be at least 6 characters.',
  reasons: ['length'],
};
const emailExists = {
  name: 'AuthApiError',
  status: 422,
  code: 'email_exists',
  message: 'A user with this email address has already been registered',
};
const invalidEmailFormat = {
  name: 'AuthApiError',
  status: 400,
  code: 'validation_failed',
  message: 'Unable to validate email address: invalid format',
};
const emailRateLimit = {
  name: 'AuthApiError',
  status: 429,
  code: 'over_email_send_rate_limit',
  message: 'For security purposes, you can only request this after 52 seconds.',
};
const networkDown = { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' };
const sessionMissing = { name: 'AuthSessionMissingError', status: 400, message: 'Auth session missing!' };

describe('describePasswordChangeError: 現在のパスワードでの再認証 (reauth)', () => {
  it('現在のパスワードが違う (invalid_credentials) と、正しくないと伝える', () => {
    expect(describePasswordChangeError(invalidCredentials, 'reauth')).toBe('現在のパスワードが正しくありません。');
  });

  it('コードが無くても、メッセージが Invalid login credentials なら同じ文言にする', () => {
    expect(describePasswordChangeError({ message: 'Invalid login credentials' }, 'reauth')).toBe(
      '現在のパスワードが正しくありません。',
    );
  });

  it('通信の失敗は、パスワードの間違いと取り違えず、通信エラーとして伝える', () => {
    const message = describePasswordChangeError(networkDown, 'reauth');
    expect(message).toContain('通信に失敗しました');
    expect(message).not.toContain('正しくありません');
  });

  it('短時間にやりすぎた (429) ときは、しばらく待つよう伝える', () => {
    expect(
      describePasswordChangeError({ name: 'AuthApiError', status: 429, code: 'over_request_rate_limit', message: 'x' }, 'reauth'),
    ).toContain('しばらく待ってから');
  });

  it('それ以外のエラーは、英語のメッセージをそのまま出さず、汎用の文言にする', () => {
    const message = describePasswordChangeError({ name: 'AuthApiError', status: 500, message: 'Database error querying schema' }, 'reauth');
    expect(message).toBe('現在のパスワードを確認できませんでした。時間をおいて、もう一度お試しください。');
    expect(message).not.toContain('Database');
  });
});

describe('describePasswordChangeError: 新しいパスワードへの更新 (update)', () => {
  it('今のパスワードと同じ (same_password) と、違うものにするよう伝える', () => {
    expect(describePasswordChangeError(samePassword, 'update')).toBe(
      '新しいパスワードは、現在のパスワードと違うものにしてください。',
    );
  });

  it('弱いパスワード (weak_password) は、安全性の基準を満たさないと伝える', () => {
    expect(describePasswordChangeError(weakPassword, 'update')).toContain('安全性の基準');
  });

  it('流出済みのパスワード (reasons に pwned) は、流出を理由として伝える', () => {
    expect(describePasswordChangeError({ ...weakPassword, reasons: ['pwned'] }, 'update')).toContain('流出');
  });

  it('weak_password の reasons が配列でなくても (想定外の形でも) 例外を投げず、汎用の文言にする', () => {
    expect(() => describePasswordChangeError({ ...weakPassword, reasons: undefined }, 'update')).not.toThrow();
    expect(() => describePasswordChangeError({ ...weakPassword, reasons: {} as unknown as string[] }, 'update')).not.toThrow();
    expect(describePasswordChangeError({ ...weakPassword, reasons: {} as unknown as string[] }, 'update')).toContain('安全性の基準');
  });

  it('ログインの有効期限切れ (セッションが無い・再認証が必要) は、ログインし直すよう伝える', () => {
    for (const error of [
      sessionMissing,
      { name: 'AuthApiError', status: 403, code: 'session_not_found', message: 'Session from session_id claim in JWT does not exist' },
      { name: 'AuthApiError', status: 401, code: 'reauthentication_needed', message: 'Password update requires reauthentication' },
      { name: 'AuthApiError', status: 401, message: 'invalid JWT' },
    ]) {
      expect(describePasswordChangeError(error, 'update')).toContain('ログインし直して');
    }
  });

  it('通信の失敗・レート制限は、再認証と同じ文言になる', () => {
    expect(describePasswordChangeError(networkDown, 'update')).toContain('通信に失敗しました');
    expect(describePasswordChangeError(new TypeError('Failed to fetch'), 'update')).toContain('通信に失敗しました');
    expect(describePasswordChangeError({ status: 429, message: 'x' }, 'update')).toContain('しばらく待ってから');
  });

  it('未知のエラー・エラーの形でない値は、汎用の文言にする', () => {
    const generic = 'パスワードを変更できませんでした。時間をおいて、もう一度お試しください。';
    expect(describePasswordChangeError({ name: 'AuthApiError', status: 500, message: 'unexpected' }, 'update')).toBe(generic);
    expect(describePasswordChangeError(null, 'update')).toBe(generic);
    expect(describePasswordChangeError(undefined, 'update')).toBe(generic);
    expect(describePasswordChangeError(42, 'update')).toBe(generic);
  });

  it('更新の段階では、invalid_credentials を「現在のパスワードが違う」とは言わない (再認証の段階の文言だから)', () => {
    expect(describePasswordChangeError(invalidCredentials, 'update')).not.toContain('現在のパスワードが正しくありません');
  });
});

describe('describeEmailChangeError', () => {
  it('すでに使われているメールアドレス (email_exists) は、別のアドレスを入力するよう伝える', () => {
    expect(describeEmailChangeError(emailExists)).toContain('すでに別のアカウントで使われています');
  });

  it('形式が不正 (validation_failed + invalid format) は、形式が正しくないと伝える', () => {
    expect(describeEmailChangeError(invalidEmailFormat)).toBe('メールアドレスの形式が正しくありません。');
  });

  it('確認メールの連続送信 (over_email_send_rate_limit) は、しばらく待つよう伝える。英語の秒数メッセージは出さない', () => {
    const message = describeEmailChangeError(emailRateLimit);
    expect(message).toContain('しばらく待ってから');
    expect(message).not.toContain('52');
    expect(message).not.toContain('security');
  });

  it('送信が許可されていないアドレスは、別のアドレスを入力するよう伝える', () => {
    expect(
      describeEmailChangeError({ status: 400, code: 'email_address_not_authorized', message: 'Email address not authorized' }),
    ).toContain('別のメールアドレス');
  });

  it('通信の失敗・ログインの有効期限切れ・未知のエラー', () => {
    expect(describeEmailChangeError(networkDown)).toContain('通信に失敗しました');
    expect(describeEmailChangeError(sessionMissing)).toContain('ログインし直して');
    expect(describeEmailChangeError({ status: 500, message: 'boom' })).toBe(
      'メールアドレスの変更を受け付けられませんでした。時間をおいて、もう一度お試しください。',
    );
    expect(describeEmailChangeError(null)).toBe(
      'メールアドレスの変更を受け付けられませんでした。時間をおいて、もう一度お試しください。',
    );
  });
});

describe('判定ヘルパー', () => {
  it('isNetworkAuthError: AuthRetryableFetchError / status 0 / fetch の TypeError を通信の失敗とみなす', () => {
    expect(isNetworkAuthError(networkDown)).toBe(true);
    expect(isNetworkAuthError({ status: 0 })).toBe(true);
    expect(isNetworkAuthError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkAuthError(new TypeError('Load failed'))).toBe(true); // Safari
    expect(isNetworkAuthError(invalidCredentials)).toBe(false);
    expect(isNetworkAuthError(null)).toBe(false);
  });

  it('isRateLimitAuthError: 429 / レート制限のコード / 英語のメッセージ', () => {
    expect(isRateLimitAuthError(emailRateLimit)).toBe(true);
    expect(isRateLimitAuthError({ status: 429 })).toBe(true);
    expect(isRateLimitAuthError({ message: 'Too many requests' })).toBe(true);
    expect(isRateLimitAuthError(invalidCredentials)).toBe(false);
  });

  it('isSessionExpiredAuthError: セッションが無い・失効した・JWT が不正', () => {
    expect(isSessionExpiredAuthError(sessionMissing)).toBe(true);
    expect(isSessionExpiredAuthError({ code: 'session_not_found' })).toBe(true);
    expect(isSessionExpiredAuthError({ status: 401, message: 'x' })).toBe(true);
    expect(isSessionExpiredAuthError({ message: 'JWT expired' })).toBe(true);
    // 再認証のパスワード間違いは、ログイン切れではない
    expect(isSessionExpiredAuthError(invalidCredentials)).toBe(false);
    expect(isSessionExpiredAuthError(networkDown)).toBe(false);
  });
});

// @vitest-environment node
/**
 * Web の認証の画面に出す Supabase Auth (GoTrue) の失敗の文 (src/lib/auth/auth-error-message.ts。#1917 の続き)
 *
 * 新規登録・メール確認の再送・パスワードの再設定の画面が、GoTrue の英語の文 (回数の制限など) をそのまま・付け足して出していた。
 * 回数の制限は「しばらくしてから」の案内、日本語の文はそのまま、それ以外は画面ごとの固定の文にすることを確かめる
 * (画面に出る文は tests/auth-turnstile-pages.test.tsx・tests/auth-turnstile-resend-password-change.test.tsx が確かめる)
 */
import { describe, expect, it } from 'vitest';
import { AUTH_RATE_LIMITED_MESSAGE, authErrorMessageForDisplay, isAuthRateLimited } from '@/lib/auth/auth-error-message';
import { JAPANESE } from './helpers/api-error-text-scan';

const FALLBACK = '送信に失敗しました。';

describe('authErrorMessageForDisplay', () => {
  it.each([
    ['429', { status: 429, message: 'Too Many Requests' }],
    ['code over_email_send_rate_limit', { status: 400, code: 'over_email_send_rate_limit', message: 'x' }],
    ['code over_request_rate_limit', { code: 'over_request_rate_limit', message: 'x' }],
    ['文 Email rate limit exceeded', { status: 400, message: 'Email rate limit exceeded' }],
    ['文 For security purposes', { message: 'For security purposes, you can only request this after 60 seconds.' }],
  ])('回数の制限 (%s) は「しばらくしてから」の案内', (_label, error) => {
    expect(isAuthRateLimited(error)).toBe(true);
    expect(authErrorMessageForDisplay(error, FALLBACK)).toBe(AUTH_RATE_LIMITED_MESSAGE);
  });

  it.each([
    ['GoTrue の英語の文', { status: 422, code: 'email_address_invalid', message: 'Email address "x" is invalid' }],
    ['通信の失敗の例外', new TypeError('Failed to fetch')],
    ['文の無い値', { status: 500 }],
    ['null', null],
    ['文字列', 'boom'],
  ])('%s は fallback の固定の文', (_label, error) => {
    expect(isAuthRateLimited(error)).toBe(false);
    expect(authErrorMessageForDisplay(error, FALLBACK)).toBe(FALLBACK);
  });

  it('日本語の文 (画面が自分で投げた文) はそのまま出す', () => {
    expect(authErrorMessageForDisplay(new Error('メールアドレスが見つかりません'), FALLBACK)).toBe('メールアドレスが見つかりません');
  });

  it('回数の制限の案内は日本語の文で、ログインの画面と同じ「しばらくしてから再度お試しください」を含む', () => {
    expect(JAPANESE.test(AUTH_RATE_LIMITED_MESSAGE)).toBe(true);
    expect(AUTH_RATE_LIMITED_MESSAGE).toContain('しばらくしてから再度お試しください');
  });
});

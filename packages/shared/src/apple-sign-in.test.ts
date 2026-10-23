/**
 * Sign in with Apple の共有の定数と固定の文のテスト (docs/design/mobile/08-sign-in-with-apple.md §11.1)
 */
import { describe, expect, it } from 'vitest';
import {
  APPLE_AUTHORIZATION_CODE_MAX_LENGTH,
  APPLE_SIGN_IN_FLAG_ON,
  APPLE_SIGN_IN_MESSAGES,
  isAppleSignInFlagOn,
} from './apple-sign-in';

/** Apple・GoTrue の英文の語 (利用者に見せる固定の文に出さない) */
const ENGLISH_PROVIDER_WORDS = /provider|nonce|token|invalid|error|failed|denied/i;
const JAPANESE_CHARACTER = /[぀-ヿ一-鿿]/;

describe('isAppleSignInFlagOn', () => {
  it("'on'・'ON'・' on ' は true", () => {
    expect(APPLE_SIGN_IN_FLAG_ON).toBe('on');
    expect(isAppleSignInFlagOn('on')).toBe(true);
    expect(isAppleSignInFlagOn('ON')).toBe(true);
    expect(isAppleSignInFlagOn(' on ')).toBe(true);
  });

  it("undefined・''・'off'・'true'・'1' は false", () => {
    expect(isAppleSignInFlagOn(undefined)).toBe(false);
    expect(isAppleSignInFlagOn('')).toBe(false);
    expect(isAppleSignInFlagOn('   ')).toBe(false);
    expect(isAppleSignInFlagOn('off')).toBe(false);
    expect(isAppleSignInFlagOn('true')).toBe(false);
    expect(isAppleSignInFlagOn('1')).toBe(false);
  });
});

describe('APPLE_AUTHORIZATION_CODE_MAX_LENGTH', () => {
  it('Apple の認可コード (数百文字) を通す 1,024', () => {
    expect(APPLE_AUTHORIZATION_CODE_MAX_LENGTH).toBe(1024);
  });
});

describe('APPLE_SIGN_IN_MESSAGES', () => {
  it('failed・signupFailed・noIdentityToken の 3 つで、どれも空でない日本語の文 (Apple・GoTrue の英文の語を含まない)', () => {
    expect(Object.keys(APPLE_SIGN_IN_MESSAGES).sort()).toEqual(['failed', 'noIdentityToken', 'signupFailed']);
    for (const [key, message] of Object.entries(APPLE_SIGN_IN_MESSAGES)) {
      expect(message.trim(), key).not.toBe('');
      expect(message, key).toMatch(JAPANESE_CHARACTER);
      // 'Apple' は製品名なので除いてから英語の語を探す
      expect(message.replace(/Apple/g, ''), key).not.toMatch(ENGLISH_PROVIDER_WORDS);
    }
  });
});

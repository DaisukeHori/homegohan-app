/**
 * メールアドレス変更の確認リンクの 1 通目の判定 (#1187・#1574)
 */
import { describe, expect, it } from 'vitest';
import { EMAIL_CHANGE_AWAITING_OTHER_NOTICE, isEmailChangeAwaitingOtherMessage } from './email-change-link';

/** GoTrue が 1 通目の確認で付ける知らせの文 (ハッシュ・クエリから読んだあとの、デコード済みの形) */
const GOTRUE_SINGLE_CONFIRMATION = 'Confirmation link accepted. Please proceed to confirm link sent to the other email';

describe('isEmailChangeAwaitingOtherMessage', () => {
  it('GoTrue の 1 通目の知らせは「もう一方のリンク待ち」', () => {
    expect(isEmailChangeAwaitingOtherMessage(GOTRUE_SINGLE_CONFIRMATION)).toBe(true);
  });

  it('大文字と小文字の違いは問わない', () => {
    expect(isEmailChangeAwaitingOtherMessage(GOTRUE_SINGLE_CONFIRMATION.toUpperCase())).toBe(true);
  });

  it.each([
    ['空', ''],
    ['null', null],
    ['undefined', undefined],
    ['別の知らせ', 'Email confirmed'],
    ['途中まで同じ文', 'Confirmation link accepted.'],
  ])('%s は当てない', (_label, message) => {
    expect(isEmailChangeAwaitingOtherMessage(message)).toBe(false);
  });

  it('利用者へ出す文は、もう一方のメールアドレスのリンクも開くよう案内する', () => {
    expect(EMAIL_CHANGE_AWAITING_OTHER_NOTICE).toContain('もう一方のメールアドレスに届いた確認メールのリンクも開いてください');
  });
});

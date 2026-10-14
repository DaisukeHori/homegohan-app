/**
 * account-change-input のテスト (#1187)
 *
 * ログイン中のパスワード変更・メールアドレス変更の、送信前の入力の検証。
 * Web (src/app/(main)/settings/account/page.tsx) とモバイル (apps/mobile/src/lib/account-credentials.ts) が
 * 同じ規則・同じ文言を使うため、置き場を packages/shared にした。
 * Web の入口が同じ実体を公開していることは src/lib/auth/__tests__/shared-entry.test.ts が確かめる。
 */
import { describe, expect, it } from 'vitest';
import {
  EMAIL_CHANGE_PATTERN,
  normalizeEmailChangeInput,
  validatePasswordChangeInput,
} from './account-change-input';
import { PASSWORD_MIN_LENGTH, validatePassword } from './password-policy';

const VALID = { currentPassword: 'oldPass123', newPassword: 'newPass456', confirmPassword: 'newPass456' };

describe('validatePasswordChangeInput', () => {
  it('問題が無ければ null', () => {
    expect(validatePasswordChangeInput(VALID)).toBeNull();
  });

  it('確かめる順番: 現在のパスワード → 新しいパスワード → 確認の一致 → 強さ → 今と同じ', () => {
    // 全部が空なら、最初の「現在のパスワード」を返す
    expect(validatePasswordChangeInput({ currentPassword: '', newPassword: '', confirmPassword: 'x' })).toBe(
      '現在のパスワードを入力してください',
    );
    expect(validatePasswordChangeInput({ ...VALID, newPassword: '' })).toBe('新しいパスワードを入力してください');
    // 一致しないうえに弱いときは、一致しない方を先に返す
    expect(validatePasswordChangeInput({ ...VALID, newPassword: 'abc', confirmPassword: 'abd' })).toBe(
      '新しいパスワードと確認用のパスワードが一致しません',
    );
    expect(validatePasswordChangeInput({ ...VALID, newPassword: 'abc', confirmPassword: 'abc' })).toBe(
      `パスワードは${PASSWORD_MIN_LENGTH}文字以上で入力してください`,
    );
    expect(validatePasswordChangeInput({ ...VALID, newPassword: '12345678', confirmPassword: '12345678' })).toBe(
      'パスワードには英字を含めてください',
    );
    expect(validatePasswordChangeInput({ ...VALID, newPassword: VALID.currentPassword, confirmPassword: VALID.currentPassword })).toBe(
      '新しいパスワードは、現在のパスワードと違うものにしてください',
    );
  });

  it('強さの規則は validatePassword と同じもの', () => {
    for (const candidate of ['short1', 'abcdefgh', '12345678', 'abcd1234']) {
      const reason = validatePasswordChangeInput({ ...VALID, newPassword: candidate, confirmPassword: candidate });
      expect(reason).toBe(validatePassword(candidate));
    }
  });
});

describe('normalizeEmailChangeInput', () => {
  it('前後の空白を除き、小文字にそろえる', () => {
    expect(normalizeEmailChangeInput('  New.Name@Example.COM ', 'me@example.com')).toEqual({
      ok: true,
      email: 'new.name@example.com',
    });
  });

  it('空・形式違い・今と同じ (大文字小文字や空白の違いだけのものも) を止める', () => {
    expect(normalizeEmailChangeInput('   ', 'me@example.com')).toEqual({
      ok: false,
      message: '新しいメールアドレスを入力してください',
    });
    expect(normalizeEmailChangeInput('no-at-mark', 'me@example.com')).toEqual({
      ok: false,
      message: 'メールアドレスの形式が正しくありません',
    });
    expect(normalizeEmailChangeInput(' ME@Example.com', ' me@example.com ')).toEqual({
      ok: false,
      message: '現在のメールアドレスと同じです。別のメールアドレスを入力してください',
    });
  });

  it('形式の確認は大まかなものだけ (@ の前後と、ドメインの . があるか)', () => {
    expect(EMAIL_CHANGE_PATTERN.test('a@b.c')).toBe(true);
    expect(EMAIL_CHANGE_PATTERN.test('a@b')).toBe(false);
    expect(EMAIL_CHANGE_PATTERN.test('a b@c.d')).toBe(false);
  });
});

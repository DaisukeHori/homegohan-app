/**
 * src/lib/auth/validate-password.ts のユニットテスト
 * Issue #1057 (UX1-05) — signup と reset-password でパスワード要件が
 * 食い違っていた(reset-password は6文字のみでOK)ため、共有ヘルパーに一本化した。
 */

import { describe, it, expect } from 'vitest';
import { validatePassword, PASSWORD_MIN_LENGTH } from '../validate-password';

describe('validatePassword', () => {
  it('空文字を拒否する', () => {
    expect(validatePassword('')).toBe('パスワードを入力してください');
  });

  it(`${PASSWORD_MIN_LENGTH}文字未満を拒否する(旧 reset-password の6文字要件では通っていたケース)`, () => {
    expect(validatePassword('abc123')).not.toBeNull();
    expect(validatePassword('123456')).not.toBeNull();
  });

  it('英字を含まないパスワードを拒否する', () => {
    expect(validatePassword('12345678')).toBe('パスワードには英字を含めてください');
  });

  it('数字を含まないパスワードを拒否する', () => {
    expect(validatePassword('abcdefgh')).toBe('パスワードには数字を含めてください');
  });

  it(`${PASSWORD_MIN_LENGTH}文字以上・英数字混在のパスワードを許可する`, () => {
    expect(validatePassword('abcd1234')).toBeNull();
    expect(validatePassword('Password1')).toBeNull();
  });
});

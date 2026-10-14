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
  isEmailChangeFormat,
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
    expect(isEmailChangeFormat('a@b.c')).toBe(true);
    expect(isEmailChangeFormat('a@b')).toBe(false);
    expect(isEmailChangeFormat('a b@c.d')).toBe(false);
    expect(isEmailChangeFormat('@b.c')).toBe(false);
    expect(isEmailChangeFormat('a@@b.c')).toBe(false);
    expect(isEmailChangeFormat('a@.b')).toBe(false);
    expect(isEmailChangeFormat('a@b.')).toBe(false);
    expect(isEmailChangeFormat('a@.b.c')).toBe(true);
    expect(isEmailChangeFormat('a@b..')).toBe(true);
  });
});

describe('isEmailChangeFormat: 以前の正規表現と同じ判定を、長さに比例する時間で行う (CodeQL js/polynomial-redos #42)', () => {
  /** 以前の判定 (入力が長いと時間が長さの 2 乗で増える)。短い文字列での突き合わせにだけ使う */
  const LEGACY_EMAIL_CHANGE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  /** 突き合わせに使う文字: 普通の文字・@・.・空白 (半角・改行・全角・ノーブレークスペース) */
  const ALPHABET = ['a', '@', '.', ' ', '\n', '\u3000', '\u00a0'];
  /** 突き合わせる文字列の長さの上限 (7 文字 × 長さ 6 で約 14 万通り。すべての並びを試す) */
  const MAX_LENGTH = 6;

  it('長さ 0〜6 の、上の文字のすべての並びで、以前の正規表現と結果が同じ', () => {
    let checked = 0;
    let level = [''];
    for (let length = 0; length <= MAX_LENGTH; length++) {
      for (const value of level) {
        expect(isEmailChangeFormat(value), JSON.stringify(value)).toBe(LEGACY_EMAIL_CHANGE_PATTERN.test(value));
        checked++;
      }
      level = level.flatMap((prefix) => ALPHABET.map((ch) => prefix + ch));
    }
    // 7^0 + 7^1 + … + 7^6 = 137,257 通りを試したこと (突き合わせが空回りしていない)
    expect(checked).toBe(137_257);
  });

  it('"." が何度も続き、最後に空白がある長い入力でも、すぐに終わる (以前の正規表現は長さの 2 乗の時間がかかった)', () => {
    // CodeQL が示した形: '!@!.' のあと '!.' が何度も続き、最後に合わない文字がある
    const REPEAT = 100_000;
    const adversarial = `!@!.${'!.'.repeat(REPEAT)} `;
    // 長さに比例する時間なら数ミリ秒で終わる。以前の正規表現では、この長さで数十秒以上かかる。
    // 負荷の高い CI でも誤って落ちないよう、上限は大きめにとる
    const TIME_LIMIT_MS = 1_000;
    const startedAt = performance.now();
    expect(isEmailChangeFormat(adversarial)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(TIME_LIMIT_MS);
    expect(isEmailChangeFormat(adversarial.trim())).toBe(true);
  });
});

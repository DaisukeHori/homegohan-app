import { describe, expect, it } from 'vitest';
import { PROFILE_NAME_PLACEHOLDER, normalizeName, normalizeProfileName } from '@/lib/profile-name';

// #1611 プロフィールの名前の仮置きの判定 (家族の画面とホームの呼びかけが共通で使う)

describe('normalizeName', () => {
  it('前後の空白を除き、空・空白だけ・文字列でないものは null', () => {
    expect(normalizeName('  パパ ')).toBe('パパ');
    expect(normalizeName('')).toBeNull();
    expect(normalizeName('   ')).toBeNull();
    expect(normalizeName(null)).toBeNull();
    expect(normalizeName(undefined)).toBeNull();
    expect(normalizeName(42)).toBeNull();
  });
});

describe('normalizeProfileName', () => {
  it("アプリと RPC が入れる仮置きは 'Guest'", () => {
    expect(PROFILE_NAME_PLACEHOLDER).toBe('Guest');
  });

  it("仮置き ('Guest'。前後の空白を除いて厳密一致)・空・空白だけは null", () => {
    expect(normalizeProfileName('Guest')).toBeNull();
    expect(normalizeProfileName('  Guest\t')).toBeNull();
    expect(normalizeProfileName('')).toBeNull();
    expect(normalizeProfileName('  ')).toBeNull();
    expect(normalizeProfileName(null)).toBeNull();
  });

  it.each(['guest', 'GUEST', 'ゲスト', 'ゲストユーザー', 'guest user', 'Guests', '太郎'])(
    "'%s' は本人が付けた名前としてそのまま返す",
    (name) => {
      expect(normalizeProfileName(name)).toBe(name);
    },
  );

  it('前後の空白は除いて返す', () => {
    expect(normalizeProfileName(' ゲスト ')).toBe('ゲスト');
  });
});

/**
 * profile-name (プロフィールの名前の仮置き 'Guest' の判定。Web・モバイル・GET /api/onboarding/status が共通で使う。#1611・#1635) のユニットテスト
 *
 * 確かめること:
 *   - 仮置きは 'Guest' で、前後の空白を除いたうえで厳密一致したものだけを「名前が無い」とする
 *   - 大小の違い ('guest'・'GUEST') や 'ゲスト' などは本人が付けた名前としてそのまま返す (src/lib/profile-name.ts の #1611 の決まりのまま)
 *   - パッケージの入口 (index) から読める (Web とモバイルは '@homegohan/shared' から import する)
 */
import { describe, expect, it } from 'vitest';
import { PROFILE_NAME_PLACEHOLDER, normalizeName, normalizeProfileName } from './profile-name';
import * as shared from './index';

describe('PROFILE_NAME_PLACEHOLDER', () => {
  it("アプリと RPC が入れる仮置きは 'Guest'", () => {
    expect(PROFILE_NAME_PLACEHOLDER).toBe('Guest');
  });
});

describe('normalizeName', () => {
  it('前後の空白を除き、空・空白だけ・文字列でないものは null', () => {
    expect(normalizeName('  パパ ')).toBe('パパ');
    expect(normalizeName('')).toBeNull();
    expect(normalizeName(' \t\n ')).toBeNull();
    expect(normalizeName(null)).toBeNull();
    expect(normalizeName(undefined)).toBeNull();
    expect(normalizeName(42)).toBeNull();
  });

  it("'Guest' は仮置きかどうかを見ずにそのまま返す (仮置きの判定は normalizeProfileName だけ)", () => {
    expect(normalizeName(' Guest ')).toBe('Guest');
  });
});

describe('normalizeProfileName', () => {
  it.each(['Guest', ' Guest', 'Guest ', '  Guest\t', '\nGuest\n'])(
    "仮置き '%s' (前後の空白を除くと 'Guest') は名前が無いとして null",
    (value) => {
      expect(normalizeProfileName(value)).toBeNull();
    },
  );

  it('空・空白だけ・文字列でないものは null', () => {
    expect(normalizeProfileName('')).toBeNull();
    expect(normalizeProfileName('   ')).toBeNull();
    expect(normalizeProfileName(null)).toBeNull();
    expect(normalizeProfileName(undefined)).toBeNull();
    expect(normalizeProfileName(0)).toBeNull();
  });

  it.each(['guest', 'GUEST', 'gUEST', 'ゲスト', 'ゲストユーザー', 'guest user', 'Guests', 'Guest太郎', 'G uest', '太郎'])(
    "'%s' は 'Guest' と厳密一致しないので本人が付けた名前としてそのまま返す (大小は区別する)",
    (name) => {
      expect(normalizeProfileName(name)).toBe(name);
    },
  );

  it('本人が付けた名前は前後の空白を除いて返す', () => {
    expect(normalizeProfileName(' ゲスト ')).toBe('ゲスト');
    expect(normalizeProfileName('  guest\t')).toBe('guest');
  });
});

describe("パッケージの入口 ('@homegohan/shared')", () => {
  it('index から同じ関数・定数を読める', () => {
    expect(shared.normalizeProfileName).toBe(normalizeProfileName);
    expect(shared.normalizeName).toBe(normalizeName);
    expect(shared.PROFILE_NAME_PLACEHOLDER).toBe(PROFILE_NAME_PLACEHOLDER);
  });
});

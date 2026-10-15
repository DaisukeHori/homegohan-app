import { describe, expect, it } from 'vitest';

import { buildFamilyMemberNames } from '../src/lib/membership/family-member-names';
import { resolveDisplayName } from '../src/lib/user-display';

describe('resolveDisplayName', () => {
  it('returns a real nickname as-is', () => {
    expect(resolveDisplayName({
      nickname: 'ほりりん',
      email: 'user@example.com',
    })).toBe('ほりりん');
  });

  it('falls back to email local-part when nickname is a placeholder', () => {
    expect(resolveDisplayName({
      nickname: 'Guest',
      email: 'nvidia.homeftp.net@gmail.com',
    })).toBe('nvidia.homeftp.net');
  });

  it('uses user metadata when nickname is missing', () => {
    expect(resolveDisplayName({
      nickname: null,
      email: 'user@example.com',
      userMetadata: { full_name: '山田太郎' },
    })).toBe('山田太郎');
  });
});

// #1611 名前の仮置きの判定を src/lib/profile-name.ts の 1 つにまとめた (家族の画面と同じ)。
// アプリと RPC が入れる仮置きは 'Guest' だけ。'ゲスト'・'guest' などは本人が付けた名前として出す。
describe('resolveDisplayName: 仮置きの判定は家族の画面と同じ (#1611)', () => {
  it("仮置きは 'Guest' (前後の空白を除いて厳密一致) だけ。user_metadata の名前へ進む", () => {
    expect(resolveDisplayName({ nickname: '  Guest  ', userMetadata: { full_name: '山田太郎' } })).toBe('山田太郎');
    // user_metadata の側の 'Guest' も名前とみなさず、次の候補へ進む
    expect(resolveDisplayName({ nickname: 'Guest', userMetadata: { nickname: 'Guest', name: '花子' } })).toBe('花子');
    expect(resolveDisplayName({ nickname: 'Guest', email: null, userMetadata: null })).toBeNull();
  });

  it.each(['ゲスト', 'guest', 'GUEST', 'ゲストユーザー', 'guest user'])(
    "本人が付けた名前 '%s' は仮置きとみなさず、そのまま出す",
    (nickname) => {
      expect(resolveDisplayName({ nickname, userMetadata: { full_name: '山田太郎' } })).toBe(nickname);
    },
  );

  it.each(['ゲスト', 'guest', 'GUEST', 'ゲストユーザー', 'guest user', 'Guest', ' Guest ', '', '   '])(
    "プロフィールの名前 '%s' を、ホームの呼びかけと家族の画面が同じく扱う",
    (nickname) => {
      const home = resolveDisplayName({ nickname, email: null, userMetadata: null });
      const [family] = buildFamilyMemberNames(
        [{ id: 'm1', user_id: 'u1', display_name: null }],
        new Map([['u1', nickname]]),
      );
      expect(family.name).toBe(home);
    },
  );
});

/**
 * src/lib/auth/frozen.ts のユニットテスト
 * #1030 [Crit] frozen_at/BAN の enforcement
 */
import { describe, it, expect } from 'vitest';
import { isAccountFrozen } from '../frozen';

describe('isAccountFrozen', () => {
  it('frozen_at が null の場合 false を返す (凍結されていない)', () => {
    expect(isAccountFrozen({ frozenAt: null, unbanAt: null })).toBe(false);
  });

  it('frozen_at が undefined の場合も false を返す', () => {
    expect(isAccountFrozen({ frozenAt: undefined, unbanAt: null })).toBe(false);
  });

  it('frozen_at がセットされ unban_at が null (無期限 BAN) の場合 true を返す', () => {
    expect(
      isAccountFrozen({ frozenAt: '2026-07-01T00:00:00.000Z', unbanAt: null }),
    ).toBe(true);
  });

  it('frozen_at がセットされ unban_at が未来 (一時 BAN 継続中) の場合 true を返す', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(
      isAccountFrozen({ frozenAt: '2026-07-01T00:00:00.000Z', unbanAt: future }),
    ).toBe(true);
  });

  it('frozen_at がセットされ unban_at が過去 (一時 BAN 期限切れ) の場合 false を返す (自動解除)', () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(
      isAccountFrozen({ frozenAt: '2026-07-01T00:00:00.000Z', unbanAt: past }),
    ).toBe(false);
  });

  it('unban_at がちょうど現在時刻 (境界値) の場合 false を返す (経過後扱い)', () => {
    const now = new Date().toISOString();
    expect(
      isAccountFrozen({ frozenAt: '2026-07-01T00:00:00.000Z', unbanAt: now }),
    ).toBe(false);
  });
});

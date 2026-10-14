/**
 * #1184 宛先停止リスト (email_blacklist) の読み書き (src/lib/emails/suppression.ts)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  inFilter: vi.fn(),
  abortSignal: vi.fn(),
  getSupabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: mocks.getSupabaseAdmin,
}));

import { addToEmailBlacklist, lookupEmailSuppression, normalizeEmailAddress } from '@/lib/emails/suppression';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upsert.mockResolvedValue({ error: null });
  mocks.abortSignal.mockResolvedValue({ data: [], error: null });
  const select = { in: mocks.inFilter, limit: () => select, abortSignal: mocks.abortSignal };
  mocks.inFilter.mockReturnValue(select);
  mocks.getSupabaseAdmin.mockReturnValue({
    from: (table: string) => {
      expect(table).toBe('email_blacklist');
      return { upsert: mocks.upsert, select: () => select };
    },
  });
});

describe('normalizeEmailAddress', () => {
  it('前後の空白を取り、小文字にそろえる', () => {
    expect(normalizeEmailAddress('  Taro.Y@Example.COM ')).toBe('taro.y@example.com');
  });
});

describe('addToEmailBlacklist', () => {
  it('小文字にそろえ重複を除いて、ON CONFLICT DO NOTHING (ignoreDuplicates) で入れる', async () => {
    const result = await addToEmailBlacklist(['A@Example.com', 'a@example.com', ' ', 'b@example.com'], 'bounce', '2026-10-14T00:00:00.000Z');

    expect(result).toEqual({ ok: true });
    expect(mocks.upsert).toHaveBeenCalledWith(
      [
        { email: 'a@example.com', reason: 'bounce', added_at: '2026-10-14T00:00:00.000Z' },
        { email: 'b@example.com', reason: 'bounce', added_at: '2026-10-14T00:00:00.000Z' },
      ],
      { onConflict: 'email', ignoreDuplicates: true },
    );
  });

  it('宛先が無ければ DB に触らない', async () => {
    expect(await addToEmailBlacklist([], 'complaint', '2026-10-14T00:00:00.000Z')).toEqual({ ok: true });
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('DB のエラー・例外は ok: false で返す (例外にしない)', async () => {
    const dbError = { message: 'boom', code: '42501' };
    mocks.upsert.mockResolvedValueOnce({ error: dbError });
    expect(await addToEmailBlacklist(['a@example.com'], 'bounce', 'x')).toEqual({ ok: false, error: dbError });

    mocks.getSupabaseAdmin.mockImplementationOnce(() => {
      throw new Error('missing env');
    });
    expect((await addToEmailBlacklist(['a@example.com'], 'bounce', 'x')).ok).toBe(false);
  });
});

describe('lookupEmailSuppression', () => {
  it('小文字にそろえた形と元の形の両方で引き、行があれば suppressed (理由つき)', async () => {
    mocks.abortSignal.mockResolvedValueOnce({ data: [{ email: 'a@example.com', reason: 'complaint' }], error: null });

    expect(await lookupEmailSuppression('A@Example.com')).toEqual({ status: 'suppressed', reason: 'complaint' });
    expect(mocks.inFilter).toHaveBeenCalledWith('email', ['a@example.com', 'A@Example.com']);
    // 待ち時間の上限つきで引く
    expect(mocks.abortSignal.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });

  it('既に小文字なら同じ値を 2 回渡さない。行が無ければ clear', async () => {
    expect(await lookupEmailSuppression('a@example.com')).toEqual({ status: 'clear' });
    expect(mocks.inFilter).toHaveBeenCalledWith('email', ['a@example.com']);
  });

  it('DB のエラー・例外 (時間切れなど) は lookup_failed で返す (例外にしない)', async () => {
    const dbError = { message: 'canceling statement due to statement timeout', code: '57014' };
    mocks.abortSignal.mockResolvedValueOnce({ data: null, error: dbError });
    expect(await lookupEmailSuppression('a@example.com')).toEqual({ status: 'lookup_failed', error: dbError });

    mocks.abortSignal.mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'));
    expect((await lookupEmailSuppression('a@example.com')).status).toBe('lookup_failed');
  });
});

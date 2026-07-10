/**
 * #1041 round-2 (D/H) 回帰防止テスト
 * src/lib/admin/user-ban.ts — BAN (凍結) 適用ヘルパー
 *
 * 検証観点:
 *  - `admin_set_user_roles` (roles=['banned']) ではなく、freeze route と同じ
 *    `user_profiles.frozen_at/frozen_reason/frozen_by` を更新すること
 *  - roles 列には一切書き込まないこと ('banned' は公式 12 ロール外)
 *  - super_admin は BAN 対象から除外されること
 *  - temporary BAN は duration_days から unbanAt を計算すること (永続化列は無い)
 *  - permanent BAN は unbanAt が null であること
 *  - DB エラー時は success:false を返すこと (例外にせず、呼び出し側で
 *    success:true を返させないための contract)
 */
import { describe, expect, it, vi } from 'vitest';
import { applyUserBan } from '@/lib/admin/user-ban';

interface FakeProfile {
  id: string;
  roles: string[];
}

function createBanTestSupabase(opts: {
  profile: FakeProfile | null;
  profileError?: { message: string } | null;
  updateError?: { message: string } | null;
}) {
  const updateCalls: unknown[] = [];
  const eqCallsAfterUpdate: unknown[][] = [];

  const from = vi.fn((table: string) => {
    if (table !== 'user_profiles') {
      throw new Error(`unexpected table: ${table}`);
    }
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() =>
            Promise.resolve({ data: opts.profile, error: opts.profileError ?? null }),
          ),
        })),
      })),
      update: vi.fn((payload: unknown) => {
        updateCalls.push(payload);
        return {
          eq: vi.fn((...args: unknown[]) => {
            eqCallsAfterUpdate.push(args);
            return Promise.resolve({ data: null, error: opts.updateError ?? null });
          }),
        };
      }),
    };
  });

  return { from, updateCalls, eqCallsAfterUpdate };
}

describe('applyUserBan (#1041 round-2 D)', () => {
  it('temporary BAN: frozen_at/frozen_reason/frozen_by を更新し、roles には触れない。unbanAt を計算する', async () => {
    const supabase = createBanTestSupabase({ profile: { id: 'owner-1', roles: ['user'] } });

    const result = await applyUserBan(supabase as never, {
      userId: 'owner-1',
      actorId: 'admin-1',
      banType: 'temporary',
      reason: '[moderation:food] spam',
      durationDays: 7,
    });

    expect(result.success).toBe(true);
    expect(result.unbanAt).toEqual(expect.any(String));
    expect(new Date(result.unbanAt!).getTime()).toBeGreaterThan(Date.now());

    expect(supabase.updateCalls).toHaveLength(1);
    const payload = supabase.updateCalls[0] as Record<string, unknown>;
    expect(payload.frozen_at).toEqual(expect.any(String));
    expect(payload.frozen_reason).toBe('[moderation:food] spam');
    expect(payload.frozen_by).toBe('admin-1');
    expect(payload).not.toHaveProperty('roles');
    // #1030: unban_at も user_profiles に永続化されること (判定時比較による自動解除のため)
    expect(payload.unban_at).toBe(result.unbanAt);
    // 対象ユーザーの id にスコープされていること
    expect(supabase.eqCallsAfterUpdate[0]).toEqual(['id', 'owner-1']);
  });

  it('permanent BAN: unbanAt は null (無期限)', async () => {
    const supabase = createBanTestSupabase({ profile: { id: 'owner-2', roles: ['user'] } });

    const result = await applyUserBan(supabase as never, {
      userId: 'owner-2',
      actorId: 'sa-1',
      banType: 'permanent',
      reason: '[moderation:recipe] abuse',
    });

    expect(result.success).toBe(true);
    expect(result.unbanAt).toBeNull();
    // #1030: permanent BAN は unban_at も null で永続化されること
    const payload = supabase.updateCalls[0] as Record<string, unknown>;
    expect(payload.unban_at).toBeNull();
  });

  it('super_admin は BAN 対象から除外する (更新を実行しない)', async () => {
    const supabase = createBanTestSupabase({ profile: { id: 'owner-3', roles: ['user', 'super_admin'] } });

    const result = await applyUserBan(supabase as never, {
      userId: 'owner-3',
      actorId: 'admin-1',
      banType: 'permanent',
      reason: 'test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/super_admin/);
    expect(supabase.updateCalls).toHaveLength(0);
  });

  it('対象ユーザーが存在しない場合は success:false', async () => {
    const supabase = createBanTestSupabase({ profile: null });

    const result = await applyUserBan(supabase as never, {
      userId: 'missing',
      actorId: 'admin-1',
      banType: 'permanent',
      reason: 'test',
    });

    expect(result.success).toBe(false);
    expect(supabase.updateCalls).toHaveLength(0);
  });

  it('プロフィール取得エラー時は例外にせず success:false を返す', async () => {
    const supabase = createBanTestSupabase({
      profile: null,
      profileError: { message: 'connection reset' },
    });

    const result = await applyUserBan(supabase as never, {
      userId: 'owner-4',
      actorId: 'admin-1',
      banType: 'permanent',
      reason: 'test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('connection reset');
  });

  it('frozen_at 更新エラー時は例外にせず success:false を返す (呼び出し側が success:true を返さないための contract)', async () => {
    const supabase = createBanTestSupabase({
      profile: { id: 'owner-5', roles: ['user'] },
      updateError: { message: 'update failed' },
    });

    const result = await applyUserBan(supabase as never, {
      userId: 'owner-5',
      actorId: 'admin-1',
      banType: 'temporary',
      reason: 'test',
      durationDays: 3,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('update failed');
  });
});

// @vitest-environment node
/**
 * src/__tests__/api/feature-flags.test.ts
 *
 * #1148 GET /api/feature-flags (クライアント向けの機能フラグ)
 *
 * - ログインしていなくても答える (メンテナンス中かどうかは、ログイン前の画面でも要る)
 * - 返すのは許可リスト (ai_chat_enabled / maintenance_mode) だけ。運営が作った別のフラグの名前を見せない
 * - 値はログイン中のユーザーにとっての ON/OFF。ユーザー本人の属性 (roles・組織・プラン・作成日) を判定に渡す
 * - 運営 (admin / super_admin) には、メンテナンス中でも maintenance_mode = false (クライアントが画面を閉じない)
 * - 認証基盤の不調・プロフィールの読み出しの失敗では、止めずに答える
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  profile: vi.fn(),
  isFeatureEnabled: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: h.getUser },
    from: (table: string) => {
      if (table !== 'user_profiles') throw new Error(`想定外の表 ${table}`);
      const builder: any = {
        select: () => builder,
        eq: (column: string, value: string) => {
          builder.eqArgs = [column, value];
          return builder;
        },
        maybeSingle: () => h.profile(builder.eqArgs),
      };
      return builder;
    },
  }),
}));

vi.mock('@/lib/feature-flags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/feature-flags')>();
  return {
    ...actual,
    isFeatureEnabled: (key: string, userId?: string, options?: unknown) => h.isFeatureEnabled(key, userId, options),
  };
});

import { GET } from '@/app/api/feature-flags/route';

/** フラグごとの値を決める。指定の無いフラグは ON */
function setFlags(values: Record<string, boolean>) {
  h.isFeatureEnabled.mockImplementation(async (key: string) => values[key] ?? true);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getUser.mockResolvedValue({ data: { user: null }, error: null });
  h.profile.mockResolvedValue({ data: null, error: null });
  setFlags({});
});

describe('GET /api/feature-flags', () => {
  it('未ログインでも 200。許可リストの 2 つだけを返し、キャッシュさせない', async () => {
    setFlags({ ai_chat_enabled: true, maintenance_mode: false });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ data: { flags: { ai_chat_enabled: true, maintenance_mode: false } } });
    expect(h.profile).not.toHaveBeenCalled();
  });

  it('未ログインでは userId を渡さずに判定する', async () => {
    await GET();

    expect(h.isFeatureEnabled).toHaveBeenCalledTimes(2);
    for (const call of h.isFeatureEnabled.mock.calls) {
      expect(call[1]).toBeUndefined();
    }
    expect(h.isFeatureEnabled.mock.calls.map((c) => c[0]).sort()).toEqual(['ai_chat_enabled', 'maintenance_mode']);
  });

  it('緊急停止中 (ai_chat_enabled = false) とメンテナンス中 (maintenance_mode = true) を、一般ユーザーにはそのまま返す', async () => {
    h.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    h.profile.mockResolvedValue({
      data: { roles: ['user'], organization_id: null, plan_key_cached: 'pro', created_at: '2026-01-01T00:00:00Z' },
      error: null,
    });
    setFlags({ ai_chat_enabled: false, maintenance_mode: true });

    const res = await GET();

    expect(await res.json()).toEqual({ data: { flags: { ai_chat_enabled: false, maintenance_mode: true } } });
  });

  it('ログイン中は、ユーザー ID と、本人のプロフィールの属性を判定に渡す (本人の行だけを id で絞って読む)', async () => {
    h.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    h.profile.mockResolvedValue({
      data: {
        roles: ['user', 'org_member'],
        organization_id: 'org-1',
        plan_key_cached: null,
        created_at: '2026-01-01T00:00:00Z',
      },
      error: null,
    });

    await GET();

    expect(h.profile).toHaveBeenCalledWith(['id', 'user-1']);
    for (const call of h.isFeatureEnabled.mock.calls) {
      expect(call[1]).toBe('user-1');
      expect(call[2]).toEqual({
        context: {
          roles: ['user', 'org_member'],
          organizationId: 'org-1',
          planKey: 'free', // plan_key_cached が空なら無料プラン
          accountCreatedAt: '2026-01-01T00:00:00Z',
        },
      });
    }
  });

  it.each([['admin'], ['super_admin']])(
    '%s には、メンテナンス中でも maintenance_mode = false を返す (クライアントがメンテナンス中の画面を出さない)',
    async (role) => {
      h.getUser.mockResolvedValue({ data: { user: { id: 'op-1' } }, error: null });
      h.profile.mockResolvedValue({
        data: { roles: ['user', role], organization_id: null, plan_key_cached: null, created_at: '2026-01-01T00:00:00Z' },
        error: null,
      });
      setFlags({ ai_chat_enabled: false, maintenance_mode: true });

      const res = await GET();

      // ai_chat_enabled は運営にも効く (緊急停止中は、運営の画面でも AI 相談は止まっている)
      expect(await res.json()).toEqual({ data: { flags: { ai_chat_enabled: false, maintenance_mode: false } } });
    },
  );

  it('org_admin などは運営ではないので、maintenance_mode はそのまま', async () => {
    h.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    h.profile.mockResolvedValue({
      data: { roles: ['org_admin', 'support'], organization_id: null, plan_key_cached: null, created_at: null },
      error: null,
    });
    setFlags({ maintenance_mode: true });

    const res = await GET();
    expect((await res.json()).data.flags.maintenance_mode).toBe(true);
  });

  it('プロフィールが無い (または読めない) ときは、ユーザー ID だけで判定して答える', async () => {
    h.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    h.profile.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const res = await GET();

    expect(res.status).toBe(200);
    for (const call of h.isFeatureEnabled.mock.calls) {
      expect(call[1]).toBe('user-1');
      expect(call[2]).toEqual({ context: undefined });
    }
  });

  it('認証基盤が例外を投げても (一時障害)、未ログインとして 200 で答える', async () => {
    h.getUser.mockRejectedValue(new Error('auth is down'));
    setFlags({ ai_chat_enabled: true, maintenance_mode: false });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { flags: { ai_chat_enabled: true, maintenance_mode: false } } });
    for (const call of h.isFeatureEnabled.mock.calls) {
      expect(call[1]).toBeUndefined();
    }
  });

  it('運営が作った別のフラグの名前は返さない (許可リストだけ)', async () => {
    const res = await GET();
    const body = await res.json();
    expect(Object.keys(body.data.flags).sort()).toEqual(['ai_chat_enabled', 'maintenance_mode']);
    expect(h.isFeatureEnabled.mock.calls.map((c) => c[0])).not.toContain('menu_generation_v5_wrapped');
  });
});

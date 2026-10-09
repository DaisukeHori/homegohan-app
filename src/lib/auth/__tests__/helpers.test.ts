/**
 * src/lib/auth/helpers.ts のユニットテスト
 * cross/01-auth-session.md §14 / operator/02-api-spec.md §3.1 準拠
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Supabase モック
// ─────────────────────────────────────────────────────────────────────────────

const mockGetUser = vi.fn();

// クエリビルダーのチェーンをセットアップするファクトリ
function makeQueryBuilder(finalResult: { data?: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn().mockReturnValue(builder);
  builder.eq = vi.fn().mockReturnValue(builder);
  builder.single = vi.fn().mockResolvedValue(finalResult);
  return builder;
}

const supabaseClient = {
  auth: {
    getUser: mockGetUser,
  },
  from: vi.fn(),
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => supabaseClient,
}));

// ─────────────────────────────────────────────────────────────────────────────
// テスト対象のインポート (モック設定後)
// ─────────────────────────────────────────────────────────────────────────────

import * as authHelpers from '../helpers';
import * as authBarrel from '../index';
import * as authErrors from '../errors';
import { requireUser, requireRole, requireOrgRole } from '../helpers';
import { AuthError, ForbiddenError } from '../errors';

// ─────────────────────────────────────────────────────────────────────────────
// テストヘルパー
// ─────────────────────────────────────────────────────────────────────────────

const fakeUser = { id: 'user-id-1', email: 'test@example.com' };

function setupGetUser(user: typeof fakeUser | null, error: unknown = null) {
  mockGetUser.mockResolvedValue({ data: { user }, error });
}

function setupUserProfile(
  userId: string,
  roles: string[],
  organization_id: string | null = null,
  frozen_at: string | null = null,
  unban_at: string | null = null,
) {
  const profileBuilder = makeQueryBuilder({
    data: { roles, organization_id, frozen_at, unban_at },
    error: null,
  });
  supabaseClient.from = vi.fn().mockImplementation((table: string) => {
    if (table === 'user_profiles') {
      return profileBuilder;
    }
    return makeQueryBuilder({ data: [], error: null });
  });
}

function setupUserProfileNotFound(userId: string) {
  const profileBuilder = makeQueryBuilder({ data: null, error: { message: 'not found' } });
  supabaseClient.from = vi.fn().mockReturnValue(profileBuilder);
}

// ─────────────────────────────────────────────────────────────────────────────
// requireUser
// ─────────────────────────────────────────────────────────────────────────────

describe('requireUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('認証済みユーザーを返す', async () => {
    setupGetUser(fakeUser);
    setupUserProfile(fakeUser.id, ['user'], null);
    const user = await requireUser();
    expect(user.id).toBe(fakeUser.id);
    expect(user.email).toBe(fakeUser.email);
  });

  it('未認証 (user=null) の場合 AuthError を throw する', async () => {
    setupGetUser(null);
    await expect(requireUser()).rejects.toThrow(AuthError);
    await expect(requireUser()).rejects.toMatchObject({ code: 'AUTH_UNAUTHENTICATED' });
  });

  it('Supabase エラーがある場合 AuthError を throw する', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'auth error' } });
    await expect(requireUser()).rejects.toThrow(AuthError);
  });

  // #1030: frozen_at enforcement
  it('frozen_at がセット (無期限 BAN) されている場合 ForbiddenError(AUTH_ACCOUNT_FROZEN) を throw する', async () => {
    setupGetUser(fakeUser);
    setupUserProfile(fakeUser.id, ['user'], null, '2026-07-01T00:00:00.000Z', null);
    await expect(requireUser()).rejects.toThrow(ForbiddenError);
    await expect(requireUser()).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_FROZEN' });
  });

  it('frozen_at がセットされていても unban_at が過去 (一時 BAN 期限切れ) なら成功する', async () => {
    setupGetUser(fakeUser);
    setupUserProfile(
      fakeUser.id,
      ['user'],
      null,
      '2026-07-01T00:00:00.000Z',
      '2026-07-02T00:00:00.000Z', // 過去
    );
    const user = await requireUser();
    expect(user.id).toBe(fakeUser.id);
  });

  it('frozen_at がセットされ unban_at が未来 (一時 BAN 継続中) なら ForbiddenError を throw する', async () => {
    setupGetUser(fakeUser);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    setupUserProfile(fakeUser.id, ['user'], null, '2026-07-01T00:00:00.000Z', future);
    await expect(requireUser()).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_FROZEN' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requireRole
// ─────────────────────────────────────────────────────────────────────────────

describe('requireRole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allowedRoles にマッチするロールを持つユーザーは UserProfile を返す', async () => {
    setupGetUser(fakeUser);
    setupUserProfile(fakeUser.id, ['admin'], null);

    const profile = await requireRole(['admin', 'super_admin']);
    expect(profile.id).toBe(fakeUser.id);
    expect(profile.roles).toContain('admin');
  });

  it('allowedRoles に含まれないロールしか持たない場合 ForbiddenError を throw する', async () => {
    setupGetUser(fakeUser);
    setupUserProfile(fakeUser.id, ['user'], null);

    await expect(requireRole(['admin', 'super_admin'])).rejects.toThrow(ForbiddenError);
    await expect(requireRole(['admin', 'super_admin'])).rejects.toMatchObject({ code: 'PERM_DENIED' });
  });

  it('未認証の場合 AuthError を throw する', async () => {
    setupGetUser(null);
    await expect(requireRole(['admin'])).rejects.toThrow(AuthError);
  });

  it('user_profiles が見つからない場合 AuthError を throw する', async () => {
    setupGetUser(fakeUser);
    setupUserProfileNotFound(fakeUser.id);
    await expect(requireRole(['admin'])).rejects.toThrow(AuthError);
    await expect(requireRole(['admin'])).rejects.toMatchObject({ code: 'AUTH_PROFILE_NOT_FOUND' });
  });

  it('複数ロールのうちいずれか一つが allowedRoles に含まれれば成功する', async () => {
    setupGetUser(fakeUser);
    setupUserProfile(fakeUser.id, ['user', 'support'], null);

    const profile = await requireRole(['support', 'admin']);
    expect(profile.roles).toContain('support');
  });

  it('finance ロールで finance 画面にアクセスできる', async () => {
    setupGetUser(fakeUser);
    setupUserProfile(fakeUser.id, ['finance'], null);

    const profile = await requireRole(['admin', 'super_admin', 'finance']);
    expect(profile.roles).toContain('finance');
  });

  // #1030: frozen_at enforcement (allowedRoles を満たしていても凍結中なら拒否)
  it('allowedRoles を満たしていても frozen_at がセットされていれば ForbiddenError(AUTH_ACCOUNT_FROZEN) を throw する', async () => {
    setupGetUser(fakeUser);
    setupUserProfile(fakeUser.id, ['admin'], null, '2026-07-01T00:00:00.000Z', null);

    await expect(requireRole(['admin', 'super_admin'])).rejects.toMatchObject({
      code: 'AUTH_ACCOUNT_FROZEN',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requireOrgRole
// ─────────────────────────────────────────────────────────────────────────────

describe('requireOrgRole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('正しい organization_id と org ロールを持つユーザーは成功する', async () => {
    const orgId = 'org-id-1';
    const profileBuilder = makeQueryBuilder({
      data: { roles: ['org_admin'], organization_id: orgId },
      error: null,
    });
    supabaseClient.from = vi.fn().mockReturnValue(profileBuilder);

    await expect(
      requireOrgRole(fakeUser.id, orgId, ['org_admin', 'org_manager']),
    ).resolves.toBeUndefined();
  });

  it('organization_id が一致しない場合 ForbiddenError(PERM_ORG_MISMATCH) を throw する', async () => {
    const profileBuilder = makeQueryBuilder({
      data: { roles: ['org_admin'], organization_id: 'other-org' },
      error: null,
    });
    supabaseClient.from = vi.fn().mockReturnValue(profileBuilder);

    await expect(
      requireOrgRole(fakeUser.id, 'org-id-1', ['org_admin']),
    ).rejects.toMatchObject({ code: 'PERM_ORG_MISMATCH' });
  });

  it('org ロールを持たない場合 ForbiddenError(PERM_DENIED) を throw する', async () => {
    const orgId = 'org-id-1';
    const profileBuilder = makeQueryBuilder({
      data: { roles: ['user'], organization_id: orgId },
      error: null,
    });
    supabaseClient.from = vi.fn().mockReturnValue(profileBuilder);

    await expect(
      requireOrgRole(fakeUser.id, orgId, ['org_admin', 'org_manager']),
    ).rejects.toMatchObject({ code: 'PERM_DENIED' });
  });

  it('user_profiles が見つからない場合 AuthError を throw する', async () => {
    const profileBuilder = makeQueryBuilder({ data: null, error: { message: 'not found' } });
    supabaseClient.from = vi.fn().mockReturnValue(profileBuilder);

    await expect(
      requireOrgRole(fakeUser.id, 'org-id-1', ['org_admin']),
    ).rejects.toThrow(AuthError);
  });

  it('org_viewer は org_viewer が許可されているルートにアクセスできる', async () => {
    const orgId = 'org-id-2';
    const profileBuilder = makeQueryBuilder({
      data: { roles: ['org_viewer'], organization_id: orgId },
      error: null,
    });
    supabaseClient.from = vi.fn().mockReturnValue(profileBuilder);

    await expect(
      requireOrgRole(fakeUser.id, orgId, ['org_admin', 'org_manager', 'org_viewer']),
    ).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// なりすまし (impersonate) は提供しない (#1124)
// ─────────────────────────────────────────────────────────────────────────────

describe('なりすまし (impersonate) は提供しない (#1124)', () => {
  // 以前は super_admin が「なりすましトークン」を発行できたが、トークンは監査ログに平文で書かれるだけで、
  // 受け取って使う側がどこにも無かった (動いているように見えて、実際には何もできない機能だった)。
  // オーナー判断 (#1124) で機能ごと削除した。サポートは、読み取り専用のユーザー画面で対応する。
  // 復活させるときは、トークンを検証する側 (セッションの分け方・赤バナー・本人の拒否設定) も一緒に設計すること。
  const REMOVED_EXPORTS = ['impersonate', 'endImpersonation', 'isImpersonating', 'ImpersonationError'];

  it.each([
    ['helpers.ts', authHelpers],
    ['errors.ts', authErrors],
    ['index.ts (barrel)', authBarrel],
  ])('%s は、なりすまし関連のものを export していない', (_file, mod) => {
    const exported = Object.keys(mod);
    for (const name of REMOVED_EXPORTS) {
      expect(exported).not.toContain(name);
    }
  });

  it('認可の入口 (requireUser / requireRole / requireOrgRole / requireOrgAdmin) は残っている', () => {
    for (const name of ['requireUser', 'requireRole', 'requireOrgRole', 'requireOrgAdmin']) {
      expect(Object.keys(authHelpers)).toContain(name);
      expect(Object.keys(authBarrel)).toContain(name);
    }
  });
});

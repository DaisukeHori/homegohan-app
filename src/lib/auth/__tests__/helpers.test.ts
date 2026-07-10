/**
 * src/lib/auth/helpers.ts のユニットテスト
 * cross/01-auth-session.md §14 / operator/02-api-spec.md §3.1 準拠
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Supabase モック
// ─────────────────────────────────────────────────────────────────────────────

const mockGetUser = vi.fn();
const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockNot = vi.fn();
const mockOrder = vi.fn();
const mockLimit = vi.fn();
const mockSingle = vi.fn();

// クエリビルダーのチェーンをセットアップするファクトリ
function makeQueryBuilder(finalResult: { data?: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn().mockReturnValue(builder);
  builder.eq = vi.fn().mockReturnValue(builder);
  builder.not = vi.fn().mockReturnValue(builder);
  builder.order = vi.fn().mockReturnValue(builder);
  builder.limit = vi.fn().mockResolvedValue(finalResult);
  builder.single = vi.fn().mockResolvedValue(finalResult);
  builder.insert = vi.fn().mockResolvedValue(finalResult);
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

import {
  requireUser,
  requireRole,
  requireOrgRole,
  impersonate,
  endImpersonation,
  isImpersonating,
} from '../helpers';
import { AuthError, ForbiddenError, ImpersonationError } from '../errors';

// ─────────────────────────────────────────────────────────────────────────────
// テストヘルパー
// ─────────────────────────────────────────────────────────────────────────────

const fakeUser = { id: 'user-id-1', email: 'test@example.com' };
const fakeSuperAdmin = { id: 'super-id-1', email: 'super@example.com' };

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
// impersonate
// ─────────────────────────────────────────────────────────────────────────────

describe('impersonate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('super_admin が impersonate すると impersonation_token と expires_at を返す', async () => {
    setupGetUser(fakeSuperAdmin);
    const auditBuilder = makeQueryBuilder({ data: null, error: null });
    supabaseClient.from = vi.fn().mockImplementation((table: string) => {
      if (table === 'user_profiles') {
        return makeQueryBuilder({ data: { roles: ['super_admin'], organization_id: null }, error: null });
      }
      return auditBuilder;
    });

    const result = await impersonate('target-user-id', 'テスト目的');
    expect(result).toHaveProperty('impersonation_token');
    expect(result).toHaveProperty('expires_at');
    expect(typeof result.impersonation_token).toBe('string');
    expect(typeof result.expires_at).toBe('string');
  });

  it('admin ロールが impersonate すると ImpersonationError を throw する', async () => {
    setupGetUser(fakeUser);
    setupUserProfile(fakeUser.id, ['admin'], null);

    await expect(impersonate('target-user-id', '理由')).rejects.toThrow(ImpersonationError);
    await expect(impersonate('target-user-id', '理由')).rejects.toMatchObject({
      code: 'AUTH_IMPERSONATION_DENIED',
    });
  });

  it('未認証の場合 AuthError を throw する', async () => {
    setupGetUser(null);
    await expect(impersonate('target-user-id', '理由')).rejects.toThrow(AuthError);
  });

  it('admin_audit_logs に action_type=impersonate の記録を挿入する', async () => {
    setupGetUser(fakeSuperAdmin);
    const insertMock = vi.fn().mockResolvedValue({ data: null, error: null });
    supabaseClient.from = vi.fn().mockImplementation((table: string) => {
      if (table === 'user_profiles') {
        return makeQueryBuilder({ data: { roles: ['super_admin'], organization_id: null }, error: null });
      }
      if (table === 'admin_audit_logs') {
        return { insert: insertMock };
      }
      return makeQueryBuilder({ data: null, error: null });
    });

    await impersonate('target-user-id', '監査テスト');
    expect(insertMock).toHaveBeenCalledOnce();
    const insertedData = insertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedData.action_type).toBe('impersonate');
    expect(insertedData.actor_id).toBe(fakeSuperAdmin.id);
    expect(insertedData.target_id).toBe('target-user-id');
  });

  it('admin_audit_logs テーブルが存在しなくても graceful に続行する', async () => {
    setupGetUser(fakeSuperAdmin);
    const insertMock = vi.fn().mockResolvedValue({ data: null, error: { message: 'table does not exist' } });
    supabaseClient.from = vi.fn().mockImplementation((table: string) => {
      if (table === 'user_profiles') {
        return makeQueryBuilder({ data: { roles: ['super_admin'], organization_id: null }, error: null });
      }
      return { insert: insertMock };
    });

    const result = await impersonate('target-user-id', '理由');
    expect(result).toHaveProperty('impersonation_token');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// endImpersonation
// ─────────────────────────────────────────────────────────────────────────────

describe('endImpersonation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('認証済みユーザーが呼ぶと admin_audit_logs に解除記録を挿入する', async () => {
    setupGetUser(fakeUser);
    const insertMock = vi.fn().mockResolvedValue({ data: null, error: null });
    supabaseClient.from = vi.fn().mockReturnValue({ insert: insertMock });

    await endImpersonation();
    expect(insertMock).toHaveBeenCalledOnce();
    const insertedData = insertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedData.action_type).toBe('impersonate_end');
  });

  it('未認証の場合 AuthError を throw する', async () => {
    setupGetUser(null);
    await expect(endImpersonation()).rejects.toThrow(AuthError);
  });

  it('admin_audit_logs テーブルが存在しなくても graceful に続行する', async () => {
    setupGetUser(fakeUser);
    const insertMock = vi.fn().mockResolvedValue({ data: null, error: { message: 'table does not exist' } });
    supabaseClient.from = vi.fn().mockReturnValue({ insert: insertMock });

    await expect(endImpersonation()).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isImpersonating
// ─────────────────────────────────────────────────────────────────────────────

describe('isImpersonating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('impersonate 記録がある場合 true を返す', async () => {
    const queryBuilder = makeQueryBuilder({ data: [{ id: 'audit-id-1' }], error: null });
    supabaseClient.from = vi.fn().mockReturnValue(queryBuilder);

    const result = await isImpersonating(fakeUser as Parameters<typeof isImpersonating>[0]);
    expect(result).toBe(true);
  });

  it('impersonate 記録がない場合 false を返す', async () => {
    const queryBuilder = makeQueryBuilder({ data: [], error: null });
    supabaseClient.from = vi.fn().mockReturnValue(queryBuilder);

    const result = await isImpersonating(fakeUser as Parameters<typeof isImpersonating>[0]);
    expect(result).toBe(false);
  });

  it('admin_audit_logs クエリが失敗した場合 graceful に false を返す', async () => {
    const queryBuilder = makeQueryBuilder({ data: null, error: { message: 'table not found' } });
    supabaseClient.from = vi.fn().mockReturnValue(queryBuilder);

    const result = await isImpersonating(fakeUser as Parameters<typeof isImpersonating>[0]);
    expect(result).toBe(false);
  });
});

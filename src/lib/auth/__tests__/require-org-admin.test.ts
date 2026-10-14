/**
 * src/lib/auth/helpers.ts の requireOrgAdmin() のユニットテスト (#1161)
 *
 * 組織 (/api/org/*) の管理系 API の入口で使う共通の認可。
 * 「所属組織の org_role が owner / admin」だけを管理者とみなす (#1235)。判定は isOrgAdmin() に一本化されていて、
 * roles 配列の 'org_admin' はどの組織の管理者かを区別できず、脱退・除名でも消えないため見ない。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: mockGetUser }, from: mockFrom }),
  getSupabaseAdmin: () => {
    throw new Error('requireOrgAdmin must not use the service role client');
  },
}));

import { requireOrgAdmin } from '../helpers';
import { AuthError, ForbiddenError } from '../errors';

const USER = { id: 'user-id-1', email: 'admin@example.com' };
const ORG_ID = 'org-id-1';

interface ProfileRow {
  organization_id?: string | null;
  org_role?: string | null;
  nickname?: string | null;
  roles?: string[];
}

/** user_profiles の .select().eq().single() の結果を差し込む。select / eq に渡された引数も返す */
function setupProfile(result: { data: ProfileRow | null; error?: { message: string } | null }) {
  const select = vi.fn();
  const eq = vi.fn();
  const single = vi.fn().mockResolvedValue({ data: result.data, error: result.error ?? null });
  const builder = { select, eq, single };
  select.mockReturnValue(builder);
  eq.mockReturnValue(builder);
  mockFrom.mockReturnValue(builder);
  return { select, eq, single };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: USER }, error: null });
});

describe('requireOrgAdmin: 401 (未認証)', () => {
  it('getUser がエラーなら AuthError(AUTH_UNAUTHENTICATED)。プロフィールは読まない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid JWT' } });

    await expect(requireOrgAdmin()).rejects.toMatchObject({ name: 'AuthError', code: 'AUTH_UNAUTHENTICATED' });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('user が null でも AuthError', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    await expect(requireOrgAdmin()).rejects.toBeInstanceOf(AuthError);
  });
});

describe('requireOrgAdmin: 403 (組織の管理者ではない)', () => {
  it.each([
    ['org_role が member', { organization_id: ORG_ID, org_role: 'member' }],
    ['org_role が owner / admin 以外の文字列', { organization_id: ORG_ID, org_role: 'viewer' }],
    ['組織に所属していない (org_role も null)', { organization_id: null, org_role: null }],
    ['org_role が admin でも organization_id が空', { organization_id: null, org_role: 'admin' }],
    ['org_role が admin でも organization_id が空文字', { organization_id: '', org_role: 'admin' }],
    // #1235: 別の組織で org_admin だった名残が roles に残っているだけのユーザーは、管理者ではない
    ['roles に org_admin が残っているだけ (org_role が member)', { organization_id: ORG_ID, org_role: 'member', roles: ['user', 'org_admin'] }],
    ['roles に org_admin が残っているだけ (所属なし)', { organization_id: null, org_role: null, roles: ['user', 'org_admin'] }],
    ['roles に admin / super_admin があっても、組織の管理者ではない', { organization_id: null, org_role: null, roles: ['admin', 'super_admin'] }],
  ])('%s', async (_label, profile) => {
    setupProfile({ data: profile });

    await expect(requireOrgAdmin()).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireOrgAdmin()).rejects.toMatchObject({ code: 'PERM_DENIED', message: 'owner/admin role required' });
  });

  it('プロフィールが無い (行が見つからない) ときも 403', async () => {
    setupProfile({ data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } });

    await expect(requireOrgAdmin()).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('requireOrgAdmin: 成功', () => {
  it.each(['owner', 'admin'])('org_role が %s なら、認証済みユーザーと所属組織を返す', async (orgRole) => {
    setupProfile({ data: { organization_id: ORG_ID, org_role: orgRole, nickname: '山田' } });

    const context = await requireOrgAdmin();

    expect(context.user).toBe(USER);
    expect(context.profile).toEqual({ organization_id: ORG_ID, org_role: orgRole, nickname: '山田' });
  });

  it('nickname が未設定なら null', async () => {
    setupProfile({ data: { organization_id: ORG_ID, org_role: 'admin', nickname: undefined } });

    const context = await requireOrgAdmin();

    expect(context.profile.nickname).toBeNull();
  });

  it('roles 配列に org_admin が無くても、org_role が admin なら通る', async () => {
    setupProfile({ data: { organization_id: ORG_ID, org_role: 'admin', roles: ['user'] } });

    await expect(requireOrgAdmin()).resolves.toMatchObject({ profile: { org_role: 'admin' } });
  });

  it('呼び出した本人の user_profiles だけを、必要な列だけ読む (roles は読まない)', async () => {
    const { select, eq } = setupProfile({ data: { organization_id: ORG_ID, org_role: 'owner' } });

    await requireOrgAdmin();

    expect(mockFrom).toHaveBeenCalledWith('user_profiles');
    expect(select).toHaveBeenCalledWith('organization_id, org_role, nickname');
    expect(eq).toHaveBeenCalledWith('id', USER.id);
  });
});

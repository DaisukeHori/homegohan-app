/**
 * #1132 組織のメンバー向け API の認可ヘルパー requireOrgMember() (src/lib/auth/org-member.ts) のテスト
 *
 * 組織の管理者だけを通す requireOrgAdmin() と対になる。確かめること:
 *   - 未ログインは AuthError (401)
 *   - いずれかの組織に所属していれば、役割 (owner / admin / member) を問わず通す。戻り値の organization_id は本人のプロフィールの値
 *   - 組織に所属していない人・プロフィールの行が無い人は ForbiddenError (403)
 *   - プロフィールを読めなかった (DB の障害) ときは、「所属していない (403)」と取り違えず、通常の例外にする
 *   - 本人の行だけを、認証で確定した本人の ID で読む
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDb, type DbError, type SchemaDb } from './helpers/schema-checked-db';
import { makeClient, profileRow, uuid, type FakeUser } from './helpers/route-world';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';

let sessionUser: FakeUser | null = null;
let sessionDb: SchemaDb;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => makeClient(sessionDb, sessionUser),
}));

const { requireOrgMember } = await import('@/lib/auth/org-member');

const ORG = uuid(100);
const DEPT = uuid(301);
const OWNER = uuid(1);
const ADMIN = uuid(2);
const MEMBER = uuid(3);
const MEMBER_NO_DEPT = uuid(4);
const OUTSIDER = uuid(5);

function setup(options: { actor?: string | null; errors?: Record<string, DbError> } = {}) {
  const actor = options.actor === undefined ? MEMBER : options.actor;
  sessionUser = actor === null ? null : { id: actor, email: 'actor@example.com' };
  sessionDb = createSchemaDb({
    tables: {
      user_profiles: [
        profileRow(OWNER, { organization_id: ORG, org_role: 'owner' }),
        profileRow(ADMIN, { organization_id: ORG, org_role: 'admin' }),
        profileRow(MEMBER, { organization_id: ORG, org_role: 'member', department_id: DEPT }),
        profileRow(MEMBER_NO_DEPT, { organization_id: ORG, org_role: 'member' }),
        profileRow(OUTSIDER, {}),
      ],
    },
    errors: options.errors,
  });
}

beforeEach(() => {
  setup();
});

describe('requireOrgMember', () => {
  it('未ログインは AuthError (401 相当)。DB は読まない', async () => {
    setup({ actor: null });

    await expect(requireOrgMember()).rejects.toBeInstanceOf(AuthError);
    expect(sessionDb.queries).toHaveLength(0);
  });

  it.each([
    ['owner', OWNER],
    ['admin', ADMIN],
    ['member', MEMBER],
  ])('組織の %s は通る。戻り値は本人のプロフィールの組織・部署', async (_label, actor) => {
    setup({ actor });

    const context = await requireOrgMember();

    expect(context.user.id).toBe(actor);
    expect(context.profile.organization_id).toBe(ORG);
  });

  it('部署に所属していれば department_id を返す。所属していなければ null', async () => {
    setup({ actor: MEMBER });
    expect((await requireOrgMember()).profile.department_id).toBe(DEPT);

    setup({ actor: MEMBER_NO_DEPT });
    expect((await requireOrgMember()).profile.department_id).toBeNull();
  });

  it('組織に所属していない人は ForbiddenError (403 相当)', async () => {
    setup({ actor: OUTSIDER });

    const error = await requireOrgMember().catch((e) => e);

    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).code).toBe('PERM_NOT_ORG_MEMBER');
  });

  it('プロフィールの行が無い人も ForbiddenError (403 相当)', async () => {
    setup({ actor: uuid(777) });

    await expect(requireOrgMember()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('本人の行だけを、認証で確定した本人の ID で読む (必要な 2 列だけ)', async () => {
    setup({ actor: ADMIN });

    await requireOrgMember();

    const queries = sessionDb.recorded('user_profiles', 'select');
    expect(queries).toHaveLength(1);
    expect(queries[0].select).toBe('organization_id, department_id');
    expect(queries[0].eq).toEqual([['id', ADMIN]]);
  });

  it('プロフィールを読めなかった (DB の障害) ときは、403 にせず通常の例外にする (呼び出し側が 500 にして記録する)', async () => {
    setup({ errors: { user_profiles: { message: 'connection refused', code: '08006' } } });

    const error = await requireOrgMember().catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ForbiddenError);
    expect(error).not.toBeInstanceOf(AuthError);
    expect((error as Error).message).toContain('connection refused');
  });
});

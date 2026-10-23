/**
 * 利用者の凍結の同時の変更 (#1917 の範囲の外として 10/23 の整合で挙がった候補 (b))
 *
 * 凍結の前に「対象が super_admin でない」ことを読んで確かめる。読んでから書くまでに別の運営が対象を super_admin にすると、
 * 以前は条件なしの UPDATE で super_admin を凍結できた。いまは凍結の UPDATE を「読んだ時点の super_admin でない状態のままなら書く」
 * 条件つきにする (読んだ roles が NULL なら .is('roles', null)、そうでなければ .not('roles', 'cs', SUPER_ADMIN_ROLES_LITERAL)。
 * roles が NULL の利用者は super_admin でないので凍結できる。NULL を読んだあとで roles に値が入ったときは、念のため書かない)。
 *
 *  - POST /api/admin/users/{id}/freeze: 0 行なら読み直して、対象が無ければ 404、あれば 409 CONFLICT_STALE_DATA (書かず、監査も残さない)
 *  - applyUserBan (モデレーションの BAN): 0 行なら読み直して、無ければ kind 'not_found'、super_admin なら kind 'super_admin'、
 *    どちらでもなければ kind 'internal' (書いていないので成功にしない)
 *
 * 別の運営の操作は、user_profiles の更新が DB に送られる直前 (と直後) に割り込ませて再現する。
 * schema-checked-db は route が付けた .is / .not の条件を実際に当てる (NULL の roles は not.cs に合わない。SQL と同じ)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDb, type Row, type SchemaDb } from './helpers/schema-checked-db';
import { profileRow, uuid } from './helpers/route-world';
import { applyUserBan, SUPER_ADMIN_ROLES_LITERAL } from '@/lib/admin/user-ban';

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

/** service_role の client が見る DB (利用者の行) */
let serviceDb: SchemaDb;
/** 運営本人のセッションの client が見る DB (監査ログ) */
let sessionDb: SchemaDb;

/** user_profiles の更新が DB に送られる直前に 1 回だけ実行する (別の運営の操作) */
let beforeProfileUpdate: (() => PromiseLike<unknown>) | null = null;
/** user_profiles の更新が終わった直後 (読み直しの前) に 1 回だけ実行する */
let afterProfileUpdate: (() => PromiseLike<unknown>) | null = null;

function interleavingFrom(table: string) {
  const query = serviceDb.from(table);
  if (table !== 'user_profiles') return query;
  let isUpdate = false;
  const update = query.update.bind(query);
  query.update = (values) => {
    isUpdate = true;
    return update(values);
  };
  type Result = Awaited<ReturnType<typeof query.single>>;
  const wrap = (terminal: () => Promise<Result>) => async (): Promise<Result> => {
    if (isUpdate && beforeProfileUpdate) {
      const interleave = beforeProfileUpdate;
      beforeProfileUpdate = null;
      await interleave();
    }
    const result = await terminal();
    if (isUpdate && afterProfileUpdate) {
      const interleave = afterProfileUpdate;
      afterProfileUpdate = null;
      await interleave();
    }
    return result;
  };
  query.single = wrap(query.single.bind(query));
  query.maybeSingle = wrap(query.maybeSingle.bind(query));
  return query;
}

const serviceClient = () => ({ from: interleavingFrom });

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ from: (table: string) => sessionDb.from(table) }),
  getSupabaseAdmin: () => serviceClient(),
}));

const { POST } = await import('@/app/api/admin/users/[id]/freeze/route');

const ACTOR_ID = uuid(1);
const TARGET_ID = uuid(50);
const ACTOR = { id: ACTOR_ID, email: 'admin@example.com', roles: ['admin'], organization_id: null };

function setup(target: Row | null) {
  serviceDb = createSchemaDb({ tables: { user_profiles: target ? [target] : [] } });
  sessionDb = createSchemaDb({ tables: { admin_audit_logs: [] } });
}

/** 別の運営が、対象の roles を書き換える */
function otherOperatorSetsRoles(roles: string[] | null) {
  return () => serviceDb.from('user_profiles').update({ roles }).eq('id', TARGET_ID);
}

function freeze() {
  return POST(
    new Request(`http://localhost/api/admin/users/${TARGET_ID}/freeze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ban_type: 'temporary', reason_category: 'spam', reason_detail: '大量の投稿', duration_days: 7 }),
    }),
    { params: Promise.resolve({ id: TARGET_ID }) },
  );
}

const targetNow = () => serviceDb.rows('user_profiles').find((row) => row.id === TARGET_ID);
const auditRows = () => sessionDb.rows('admin_audit_logs');
const json = (res: Response) => res.json() as Promise<Record<string, any>>;

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(ACTOR);
  beforeProfileUpdate = null;
  afterProfileUpdate = null;
});

describe('POST /api/admin/users/{id}/freeze', () => {
  it('割り込みが無いとき: 200 で凍結し、監査 admin.user.ban を 1 行残す。更新は super_admin でない条件つき', async () => {
    setup(profileRow(TARGET_ID, { roles: ['user'] }));
    const res = await freeze();
    expect(res.status).toBe(200);
    expect(targetNow()?.frozen_at).toEqual(expect.any(String));
    expect(targetNow()?.frozen_by).toBe(ACTOR_ID);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0].action_type).toBe('admin.user.ban');
    const updates = serviceDb.recorded('user_profiles', 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].not).toEqual([['roles', 'cs', SUPER_ADMIN_ROLES_LITERAL]]);
    expect(updates[0].isNull).toEqual([]);
  });

  it('roles が NULL の利用者は super_admin でないので凍結できる (200。条件は roles が NULL のまま)', async () => {
    setup(profileRow(TARGET_ID, { roles: null }));
    const res = await freeze();
    expect(res.status).toBe(200);
    expect(targetNow()?.frozen_at).toEqual(expect.any(String));
    expect(auditRows()).toHaveLength(1);
    const updates = serviceDb.recorded('user_profiles', 'update');
    expect(updates[0].isNull).toEqual(['roles']);
    expect(updates[0].not).toEqual([]);
  });

  it('NULL の roles を読んだあとで super_admin でないロールが入った: 念のため書かず 409 (監査も残さない)', async () => {
    setup(profileRow(TARGET_ID, { roles: null }));
    beforeProfileUpdate = otherOperatorSetsRoles(['user']);
    const res = await freeze();
    expect(res.status).toBe(409);
    expect(targetNow()?.frozen_at).toBeNull();
    expect(auditRows()).toHaveLength(0);
  });

  it('読んだ時点で super_admin なら 403 OP_TARGET_PROTECTED (書かない)', async () => {
    setup(profileRow(TARGET_ID, { roles: ['user', 'super_admin'] }));
    const res = await freeze();
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('OP_TARGET_PROTECTED');
    expect(serviceDb.recorded('user_profiles', 'update')).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('読んでから書くまでに別の運営が対象を super_admin にした: 409 CONFLICT_STALE_DATA。凍結されず、監査も残らない', async () => {
    setup(profileRow(TARGET_ID, { roles: ['user'] }));
    beforeProfileUpdate = otherOperatorSetsRoles(['user', 'super_admin']);
    const res = await freeze();
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('CONFLICT_STALE_DATA');
    expect(targetNow()?.frozen_at).toBeNull();
    expect(targetNow()?.roles).toEqual(['user', 'super_admin']);
    expect(auditRows()).toHaveLength(0);
  });

  it('読んでから書くまでに roles が NULL から super_admin になった: 409 (NULL を読んだ場合も条件が効く)', async () => {
    setup(profileRow(TARGET_ID, { roles: null }));
    beforeProfileUpdate = otherOperatorSetsRoles(['super_admin']);
    const res = await freeze();
    expect(res.status).toBe(409);
    expect(targetNow()?.frozen_at).toBeNull();
    expect(auditRows()).toHaveLength(0);
  });

  it('super_admin 以外のロールが変わっただけなら凍結する (200。条件は super_admin でないことだけ)', async () => {
    setup(profileRow(TARGET_ID, { roles: ['user'] }));
    beforeProfileUpdate = otherOperatorSetsRoles(['user', 'support']);
    const res = await freeze();
    expect(res.status).toBe(200);
    expect(targetNow()?.frozen_at).toEqual(expect.any(String));
    expect(auditRows()).toHaveLength(1);
  });

  it('読んでから書くまでに対象が消えた: 404 NOT_FOUND で、監査も残さない', async () => {
    setup(profileRow(TARGET_ID, { roles: ['user'] }));
    beforeProfileUpdate = () => serviceDb.from('user_profiles').delete().eq('id', TARGET_ID);
    const res = await freeze();
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('NOT_FOUND');
    expect(auditRows()).toHaveLength(0);
  });
});

describe('applyUserBan (モデレーションの BAN)', () => {
  const ban = () =>
    applyUserBan(serviceClient() as never, {
      userId: TARGET_ID,
      actorId: ACTOR_ID,
      banType: 'temporary',
      reason: '[moderation:food] spam',
      durationDays: 3,
    });

  it('割り込みが無いとき: 成功し、更新は super_admin でない条件つき', async () => {
    setup(profileRow(TARGET_ID, { roles: ['user'] }));
    const result = await ban();
    expect(result.success).toBe(true);
    expect(targetNow()?.frozen_at).toEqual(expect.any(String));
    expect(serviceDb.recorded('user_profiles', 'update')[0].not).toEqual([['roles', 'cs', SUPER_ADMIN_ROLES_LITERAL]]);
  });

  it('roles が NULL の利用者も BAN できる', async () => {
    setup(profileRow(TARGET_ID, { roles: null }));
    const result = await ban();
    expect(result.success).toBe(true);
    expect(targetNow()?.frozen_at).toEqual(expect.any(String));
  });

  it('読んでから書くまでに super_admin になった: kind super_admin で失敗し、凍結されない', async () => {
    setup(profileRow(TARGET_ID, { roles: ['user'] }));
    beforeProfileUpdate = otherOperatorSetsRoles(['user', 'super_admin']);
    const result = await ban();
    expect(result).toMatchObject({ success: false, unbanAt: null, kind: 'super_admin' });
    expect(result.error).toMatch(/super_admin/);
    expect(targetNow()?.frozen_at).toBeNull();
  });

  it('読んでから書くまでに対象が消えた: kind not_found', async () => {
    setup(profileRow(TARGET_ID, { roles: ['user'] }));
    beforeProfileUpdate = () => serviceDb.from('user_profiles').delete().eq('id', TARGET_ID);
    const result = await ban();
    expect(result).toMatchObject({ success: false, kind: 'not_found' });
  });

  it('0 行のあと読み直すと super_admin でなくなっていた: 書いていないので kind internal で失敗にする (成功と言わない)', async () => {
    setup(profileRow(TARGET_ID, { roles: ['user'] }));
    beforeProfileUpdate = otherOperatorSetsRoles(['super_admin']);
    afterProfileUpdate = otherOperatorSetsRoles(['user']);
    const result = await ban();
    expect(result).toMatchObject({ success: false, unbanAt: null, kind: 'internal' });
    expect(result.cause).toBeInstanceOf(Error);
    expect(targetNow()?.frozen_at).toBeNull();
  });
});

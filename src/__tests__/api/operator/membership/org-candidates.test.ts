import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createFakeServiceRole, leadingUsers, type FakeServiceRole } from './fake-service-role';

// GET /api/operator/membership/org/[id]/candidates の候補者一覧 (#1204)。
//
// 修正前は email を auth.admin.listUsers() (引数なしでは先頭 50 件のみ) から探していたため、登録ユーザーが
// 50 人を超えると候補者の email が null になり、運営が強制譲渡の相手を見分けられなかった。

const mocks = vi.hoisted(() => ({
  requireSuperAdmin: vi.fn(),
  createServiceRoleClient: vi.fn(),
  logWarn: vi.fn(),
  withUser: vi.fn(),
}));

vi.mock('@/lib/auth/operator-permissions', () => ({
  requireSuperAdmin: mocks.requireSuperAdmin,
}));

// service-role のクライアントは本物の getSupabaseAdmin を通す (#1162。接続情報は env-required の getter で取り出し、
// 下で差し替えた @supabase/supabase-js の createClient で作る)。呼ばれた回数を数え、
// 候補者のメールアドレス解決 (resolveAuthEmails) が自前で作らず、route が作ったクライアントを受け取ることを確かめる
vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>();
  return { getSupabaseAdmin: vi.fn(actual.getSupabaseAdmin) };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createServiceRoleClient,
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser: mocks.withUser,
  }),
  generateRequestId: () => 'req_test',
}));

import { GET } from '@/app/api/operator/membership/org/[id]/candidates/route';
import { getSupabaseAdmin } from '@/lib/supabase/server';

const OPERATOR_ID = 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44';
const ORG_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const OTHER_ORG_ID = 'e1eebc99-9c0b-4ef8-bb6d-6bb9bd380a56';
const EMPTY_ORG_ID = 'e2eebc99-9c0b-4ef8-bb6d-6bb9bd380a57';
const OWNER_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const ADMIN_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const MEMBER_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';
const NEVER_LOGGED_IN_ID = 'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a34';
const STRANGER_ID = 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a35';

/** ほめゴハン株式会社: オーナー (社長) のほかに管理者・一般社員・ログイン実績のない人。別会社の人は候補にならない */
function buildFake(leadingUserCount = 60): FakeServiceRole {
  return createFakeServiceRole({
    tables: {
      user_profiles: [
        { id: OWNER_ID, nickname: '社長', organization_id: ORG_ID, org_role: 'owner', last_login_at: '2026-10-05T00:00:00Z' },
        { id: ADMIN_ID, nickname: '部長', organization_id: ORG_ID, org_role: 'admin', last_login_at: '2026-10-03T00:00:00Z' },
        { id: MEMBER_ID, nickname: '社員', organization_id: ORG_ID, org_role: 'member', last_login_at: '2026-10-04T00:00:00Z' },
        { id: NEVER_LOGGED_IN_ID, nickname: '新人', organization_id: ORG_ID, org_role: 'member', last_login_at: null },
        { id: STRANGER_ID, nickname: '別会社の人', organization_id: OTHER_ORG_ID, org_role: 'member', last_login_at: null },
      ],
    },
    users: [
      ...leadingUsers(leadingUserCount),
      { id: OWNER_ID, email: 'owner@example.com' },
      { id: ADMIN_ID, email: 'admin@example.com' },
      { id: MEMBER_ID, email: 'member@example.com' },
      { id: NEVER_LOGGED_IN_ID, email: 'newcomer@example.com' },
      { id: STRANGER_ID, email: 'stranger@example.com' },
    ],
  });
}

let fake: FakeServiceRole;

beforeEach(() => {
  vi.clearAllMocks();
  // 本物のキーではないダミー値 (getSupabaseAdmin は環境変数の有無だけを見る)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');

  fake = buildFake();
  mocks.createServiceRoleClient.mockImplementation(() => fake.client);
  mocks.requireSuperAdmin.mockResolvedValue({ userId: OPERATOR_ID });
  mocks.withUser.mockImplementation(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.logWarn,
    error: vi.fn(),
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const call = (orgId: string = ORG_ID) =>
  GET(new NextRequest(`http://localhost/api/operator/membership/org/${orgId}/candidates`), {
    params: Promise.resolve({ id: orgId }),
  });

describe('GET /api/operator/membership/org/[id]/candidates: メールアドレスの表示 (#1204)', () => {
  it('候補者のメールアドレスを、Auth ユーザー一覧の先頭 50 件の外にいる人も含めて返す', async () => {
    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual([
      { id: MEMBER_ID, nickname: '社員', org_role: 'member', last_login_at: '2026-10-04T00:00:00Z', email: 'member@example.com' },
      { id: ADMIN_ID, nickname: '部長', org_role: 'admin', last_login_at: '2026-10-03T00:00:00Z', email: 'admin@example.com' },
      { id: NEVER_LOGGED_IN_ID, nickname: '新人', org_role: 'member', last_login_at: null, email: 'newcomer@example.com' },
    ]);
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('候補者はオーナー以外の所属メンバーだけ (別の組織の人は含めない)、最終ログインが新しい順', async () => {
    const res = await call();
    const json = await res.json();

    expect(json.data.map((candidate: { id: string }) => candidate.id)).toEqual([MEMBER_ID, ADMIN_ID, NEVER_LOGGED_IN_ID]);
  });

  it('候補者の分だけメールアドレスを引く (listUsers は使わない)', async () => {
    await call();

    expect(fake.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById.mock.calls.map(([id]) => id).sort()).toEqual(
      [MEMBER_ID, ADMIN_ID, NEVER_LOGGED_IN_ID].sort(),
    );
  });

  it('一部の人のメールアドレスを取得できなくても 200 を返し、その人だけ email を null にして、警告ログに残す', async () => {
    fake.authFailures.add(ADMIN_ID);

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.map((c: { id: string; email: string | null }) => [c.id, c.email])).toEqual([
      [MEMBER_ID, 'member@example.com'],
      [ADMIN_ID, null],
      [NEVER_LOGGED_IN_ID, 'newcomer@example.com'],
    ]);
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ requested: 3, failed: 1, failed_user_ids: [ADMIN_ID] });
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain('@example.com');
  });

  it('候補者がいない組織: 空の一覧を返し、Auth API は呼ばない', async () => {
    const res = await call(EMPTY_ORG_ID);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual([]);
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
  });

  it('メンバー一覧の取得に失敗: 500 INTERNAL_ERROR を返す', async () => {
    fake.readErrors.user_profiles = { message: 'connection reset by peer', code: '08006' };

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    // DB の生のエラー文は本文に出さない (#1172 / #1434)
    expect(json.error.message).toBe('処理中にエラーが発生しました');
    expect(JSON.stringify(json)).not.toContain('connection reset by peer');
  });
});

describe('GET /api/operator/membership/org/[id]/candidates: 認可', () => {
  it('未認証: 401 を返し、何も読まない', async () => {
    mocks.requireSuperAdmin.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED', '認証が必要です'));

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe('UNAUTHORIZED');
    expect(fake.events).toEqual([]);
  });

  it('super_admin 以外: 403 を返し、メールアドレスを引かない', async () => {
    mocks.requireSuperAdmin.mockRejectedValue(new ForbiddenError('PERM_DENIED', 'super_admin 権限が必要です'));

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('FORBIDDEN');
    expect(fake.events).toEqual([]);
  });
});

describe('GET /api/operator/membership/org/[id]/candidates: service-role のクライアントは canonical の getSupabaseAdmin で作る (#1162)', () => {
  it('同じ鍵・同じ設定 (セッションを保存しない・自動で更新しない) のクライアントを、候補者の一覧とメールアドレスの解決で 1 回だけ作る', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(vi.mocked(getSupabaseAdmin)).toHaveBeenCalledTimes(1);
    expect(mocks.createServiceRoleClient).toHaveBeenCalledTimes(1);
    expect(mocks.createServiceRoleClient).toHaveBeenCalledWith('http://127.0.0.1:54321', 'test-service-role-key', {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  });

  it('認可 (requireSuperAdmin) に落ちたら、service-role のクライアントを作らない', async () => {
    mocks.requireSuperAdmin.mockRejectedValue(new ForbiddenError('PERM_DENIED', 'super_admin 権限が必要です'));

    const res = await call();

    expect(res.status).toBe(403);
    expect(vi.mocked(getSupabaseAdmin)).not.toHaveBeenCalled();
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });
});

describe('GET /api/operator/membership/org/[id]/candidates: 同じ最終ログインの人の順 (#2134 U2)', () => {
  // id の小さい順に A < B < C < D。行の並び (挿入の順) は、期待する順と逆にしておく
  const TIE_A = '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01';
  const TIE_B = '20eebc99-9c0b-4ef8-bb6d-6bb9bd380a02';
  const TIE_C = '30eebc99-9c0b-4ef8-bb6d-6bb9bd380a03';
  const TIE_D = '40eebc99-9c0b-4ef8-bb6d-6bb9bd380a04';
  const SAME_LOGIN = '2026-10-10T09:00:00Z';

  it('最終ログインが同じ人・まだログインしていない人は、それぞれ id の順 (行の並びに左右されない)', async () => {
    fake = createFakeServiceRole({
      tables: {
        user_profiles: [
          { id: TIE_D, nickname: 'D', organization_id: ORG_ID, org_role: 'member', last_login_at: null },
          { id: TIE_C, nickname: 'C', organization_id: ORG_ID, org_role: 'member', last_login_at: null },
          { id: TIE_B, nickname: 'B', organization_id: ORG_ID, org_role: 'member', last_login_at: SAME_LOGIN },
          { id: TIE_A, nickname: 'A', organization_id: ORG_ID, org_role: 'admin', last_login_at: SAME_LOGIN },
        ],
      },
      users: [],
    });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.map((candidate: { id: string }) => candidate.id)).toEqual([TIE_A, TIE_B, TIE_C, TIE_D]);
  });

  it('DB に送る並びは 最終ログインの降順 (空は最後) → id の昇順', async () => {
    await call();

    expect(fake.orders).toEqual([
      { table: 'user_profiles', column: 'last_login_at', ascending: false, nullsFirst: false },
      { table: 'user_profiles', column: 'id', ascending: true, nullsFirst: false },
    ]);
  });
});

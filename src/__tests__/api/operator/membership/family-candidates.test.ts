import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createFakeServiceRole, leadingUsers, type FakeServiceRole } from './fake-service-role';

// GET /api/operator/membership/family/[id]/candidates の候補者一覧 (#1204)。
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

// 候補者のメールアドレス解決は service-role クライアントを route から受け取る (cookies() を使う本物は使わない)
vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => {
    throw new Error('route が渡した service-role クライアントを使うこと');
  },
}));

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

import { GET } from '@/app/api/operator/membership/family/[id]/candidates/route';

const OPERATOR_ID = 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44';
const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const OTHER_FAMILY_ID = 'f1eebc99-9c0b-4ef8-bb6d-6bb9bd380a67';
const EMPTY_FAMILY_ID = 'f2eebc99-9c0b-4ef8-bb6d-6bb9bd380a68';
const REP_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const ADULT_1_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const ADULT_2_ID = 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a23';
const CHILD_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';
const LEFT_ID = 'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a34';
const STRANGER_ID = 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a35';

/** 山田家: 代表者 (花子) のほかに大人が 2 人 (太郎・次郎)。子供・退会済み・別の家族のメンバーは候補にならない */
function buildFake(leadingUserCount = 60): FakeServiceRole {
  return createFakeServiceRole({
    tables: {
      family_members: [
        { family_id: FAMILY_ID, user_id: REP_ID, role: 'representative', status: 'active', joined_at: '2026-01-01T00:00:00Z' },
        { family_id: FAMILY_ID, user_id: ADULT_2_ID, role: 'adult', status: 'active', joined_at: '2026-03-01T00:00:00Z' },
        { family_id: FAMILY_ID, user_id: ADULT_1_ID, role: 'adult', status: 'active', joined_at: '2026-02-01T00:00:00Z' },
        { family_id: FAMILY_ID, user_id: CHILD_ID, role: 'child', status: 'active', joined_at: '2026-02-15T00:00:00Z' },
        { family_id: FAMILY_ID, user_id: LEFT_ID, role: 'adult', status: 'left', joined_at: '2026-01-15T00:00:00Z' },
        { family_id: OTHER_FAMILY_ID, user_id: STRANGER_ID, role: 'adult', status: 'active', joined_at: '2026-01-20T00:00:00Z' },
      ],
      user_profiles: [
        { id: REP_ID, nickname: '花子', last_login_at: '2026-10-01T00:00:00Z' },
        { id: ADULT_1_ID, nickname: '太郎', last_login_at: '2026-10-02T00:00:00Z' },
        { id: ADULT_2_ID, nickname: '次郎', last_login_at: null },
        { id: CHILD_ID, nickname: '三郎', last_login_at: null },
        { id: LEFT_ID, nickname: '退会者', last_login_at: null },
        { id: STRANGER_ID, nickname: '他の家族の人', last_login_at: null },
      ],
    },
    users: [
      ...leadingUsers(leadingUserCount),
      { id: REP_ID, email: 'rep@example.com' },
      { id: ADULT_1_ID, email: 'adult1@example.com' },
      { id: ADULT_2_ID, email: 'adult2@example.com' },
      { id: CHILD_ID, email: 'child@example.com' },
      { id: LEFT_ID, email: 'left@example.com' },
      { id: STRANGER_ID, email: 'stranger@example.com' },
    ],
  });
}

let fake: FakeServiceRole;

beforeEach(() => {
  vi.clearAllMocks();
  // 本物のキーではないダミー値 (getServiceRoleClient が環境変数の有無だけを見る)
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

const call = (familyId: string = FAMILY_ID) =>
  GET(new NextRequest(`http://localhost/api/operator/membership/family/${familyId}/candidates`), {
    params: { id: familyId },
  });

describe('GET /api/operator/membership/family/[id]/candidates: メールアドレスの表示 (#1204)', () => {
  it('候補者のメールアドレスを、Auth ユーザー一覧の先頭 50 件の外にいる人も含めて返す', async () => {
    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual([
      { id: ADULT_1_ID, role: 'adult', nickname: '太郎', email: 'adult1@example.com', last_login_at: '2026-10-02T00:00:00Z' },
      { id: ADULT_2_ID, role: 'adult', nickname: '次郎', email: 'adult2@example.com', last_login_at: null },
    ]);
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('候補者は代表者以外の active な大人だけ (子供・退会済み・別の家族の人は含めない)、参加が古い順', async () => {
    const res = await call();
    const json = await res.json();

    expect(json.data.map((candidate: { id: string }) => candidate.id)).toEqual([ADULT_1_ID, ADULT_2_ID]);
  });

  it('候補者の分だけメールアドレスを引く (listUsers は使わない)', async () => {
    await call();

    expect(fake.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById.mock.calls.map(([id]) => id).sort()).toEqual([ADULT_1_ID, ADULT_2_ID].sort());
  });

  it('一部の人のメールアドレスを取得できなくても 200 を返し、その人だけ email を null にして、警告ログに残す', async () => {
    fake.authFailures.add(ADULT_2_ID);

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.map((c: { id: string; email: string | null }) => [c.id, c.email])).toEqual([
      [ADULT_1_ID, 'adult1@example.com'],
      [ADULT_2_ID, null],
    ]);
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ requested: 2, failed: 1, failed_user_ids: [ADULT_2_ID] });
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain('@example.com');
  });

  it('候補者がいない家族: 空の一覧を返し、Auth API は呼ばない', async () => {
    const res = await call(EMPTY_FAMILY_ID);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual([]);
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
  });

  it('メンバー一覧の取得に失敗: 500 INTERNAL_ERROR を返す', async () => {
    fake.readErrors.family_members = { message: 'connection reset by peer', code: '08006' };

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    // DB の生のエラー文は本文に出さない (#1172 / #1434)
    expect(json.error.message).toBe('処理中にエラーが発生しました');
    expect(JSON.stringify(json)).not.toContain('connection reset by peer');
  });
});

describe('GET /api/operator/membership/family/[id]/candidates: 認可', () => {
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

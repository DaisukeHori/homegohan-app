/**
 * #1917 の続き: 運営の家族の代表者の強制譲渡 POST /api/operator/membership/family/{id}/transfer が、退会の途中の人を代表者にしない (route のテスト)。
 *
 * 退会 (src/lib/account-deletion.ts の deleteAccount) は findBlocker の前に退会の印 (begin_account_deletion_guard) を付ける。
 * 印のある人を representative_id にする family_groups の書き込みは、DB のトリガー trg_representative_not_deleting (関数 family_groups_representative_not_deleting) が
 * 'REPRESENTATIVE_ACCOUNT_DELETING' (P0001) で止める (supabase/migrations/20261023150000_account_deletion_family_representative_guard.sql。
 * 実 DB では tests/integration/security/account-deletion-family-rep-guard.test.ts)。
 * ここでは、その止めを route が 409 REPRESENTATIVE_ACCOUNT_DELETING (日本語の固定の文) にし、監査・通知を出さないことを確かめる。
 * (この route のほかの挙動は family-transfer.test.ts が受け持つ)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';
import { createFakeServiceRole, type FakeServiceRole } from './fake-service-role';

const mocks = vi.hoisted(() => ({
  requireSuperAdmin: vi.fn(),
  rpc: vi.fn(),
  createServiceRoleClient: vi.fn(),
  sendEmail: vi.fn(),
  recordAdminAudit: vi.fn(),
  logError: vi.fn(),
  withUser: vi.fn(),
}));

vi.mock('@/lib/auth/operator-permissions', () => ({
  requireSuperAdmin: mocks.requireSuperAdmin,
}));

// RPC は運営者本人のセッションで実行される。service-role のクライアントは本物の getSupabaseAdmin を通す (family-transfer.test.ts と同じ)
vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>();
  return {
    createClient: () => ({ rpc: mocks.rpc }),
    getSupabaseAdmin: vi.fn(actual.getSupabaseAdmin),
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createServiceRoleClient,
}));

vi.mock('@/lib/emails/send', () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock('@/lib/admin/audit', () => ({
  recordAdminAudit: mocks.recordAdminAudit,
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

import { POST } from '@/app/api/operator/membership/family/[id]/transfer/route';

const OPERATOR_ID = 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44';
const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const OLD_REP_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const NEW_REP_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const REASON = '代表者が長期間ログインしておらず、連絡も取れないため';
/** DB 関数・トリガーが RAISE EXCEPTION ... USING ERRCODE = 'P0001' で止めたときの SQLSTATE */
const PG_RAISE_EXCEPTION = 'P0001';
const REPRESENTATIVE_ACCOUNT_DELETING = 'REPRESENTATIVE_ACCOUNT_DELETING';
const HTTP_CONFLICT = 409;
const HTTP_INTERNAL_ERROR = 500;

let fake: FakeServiceRole;

beforeEach(() => {
  vi.clearAllMocks();
  // 本物のキーではないダミー値 (getSupabaseAdmin は環境変数の有無だけを見る)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');

  fake = createFakeServiceRole({
    tables: {
      family_groups: [{ id: FAMILY_ID, name: '山田家', representative_id: OLD_REP_ID }],
      family_members: [
        { family_id: FAMILY_ID, user_id: OLD_REP_ID, role: 'representative', status: 'active' },
        { family_id: FAMILY_ID, user_id: NEW_REP_ID, role: 'adult', status: 'active' },
      ],
      user_profiles: [
        { id: OLD_REP_ID, nickname: '花子' },
        { id: NEW_REP_ID, nickname: '太郎' },
      ],
    },
    users: [
      { id: OLD_REP_ID, email: 'old-rep@example.com' },
      { id: NEW_REP_ID, email: 'new-rep@example.com' },
    ],
  });
  mocks.createServiceRoleClient.mockImplementation(() => fake.client);
  mocks.requireSuperAdmin.mockResolvedValue({ userId: OPERATOR_ID });
  mocks.sendEmail.mockResolvedValue({ id: 'email-1' });
  mocks.recordAdminAudit.mockResolvedValue(undefined);
  mocks.withUser.mockImplementation(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.logError }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const call = () =>
  POST(
    new NextRequest(`http://localhost/api/operator/membership/family/${FAMILY_ID}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_user_id: NEW_REP_ID, reason: REASON }),
    }),
    { params: Promise.resolve({ id: FAMILY_ID }) },
  );

describe('POST /api/operator/membership/family/[id]/transfer: 譲渡先が退会の手続き中 (#1917 の続き)', () => {
  it('DB が REPRESENTATIVE_ACCOUNT_DELETING (P0001) で止めたら 409 と日本語の固定の文。監査・通知を出さず、構造化ログにも失敗として残さない', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: PG_RAISE_EXCEPTION, message: REPRESENTATIVE_ACCOUNT_DELETING } });

    const res = await call();

    expect(res.status).toBe(HTTP_CONFLICT);
    expect(await res.json()).toEqual({
      error: { code: REPRESENTATIVE_ACCOUNT_DELETING, message: '譲渡先のユーザーは退会の手続き中です' },
    });
    expect(mocks.rpc).toHaveBeenCalledWith('operator_force_representative_transfer', {
      p_family_id: FAMILY_ID,
      p_new_rep_id: NEW_REP_ID,
      p_reason: REASON,
    });
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(fake.tables.family_groups[0].representative_id).toBe(OLD_REP_ID);
  });

  it.each([
    ['ほかの SQLSTATE で同じ文', { code: '23505', message: REPRESENTATIVE_ACCOUNT_DELETING }],
    ['SQLSTATE が無い', { message: REPRESENTATIVE_ACCOUNT_DELETING }],
    ['文の一部にコードを含むだけ', { code: PG_RAISE_EXCEPTION, message: `x ${REPRESENTATIVE_ACCOUNT_DELETING} y` }],
  ])('%s の失敗は従来どおり汎用の 500 (409 と取り違えない)', async (_label, error) => {
    mocks.rpc.mockResolvedValue({ data: null, error });

    const res = await call();

    expect(res.status).toBe(HTTP_INTERNAL_ERROR);
    expect(await res.json()).toEqual({ error: { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE } });
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

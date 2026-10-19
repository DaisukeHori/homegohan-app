import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { EmailSendError } from '@/lib/emails/send-result';
import { createFakeServiceRole, leadingUsers, type FakeServiceRole } from '../operator/membership/fake-service-role';

// POST /api/family/dissolve — 代表者が自分の家族グループを解散する (#1917。docs/design/family/11-self-dissolve.md §14.1・§21.1)。
//
// 外部との境界 (本人のセッションの Supabase・service_role の Supabase・メールの送信・ログ) はモックにする。
// 宛先の解決 (resolveAuthEmails) と文面 (renderSelfDissolveEmail) は実物を通す。

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  createClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
  sendEmail: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  withUser: vi.fn(),
}));

// 本人のセッションの client (cookies() を使う本物の createClient は使わない)。service_role の client は本物の getSupabaseAdmin を通す
vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>();
  return {
    createClient: mocks.createClient,
    getSupabaseAdmin: vi.fn(actual.getSupabaseAdmin),
  };
});

// service_role の client (getSupabaseAdmin が作る) の実体
vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createServiceRoleClient,
}));

vi.mock('@/lib/emails/send', () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.logWarn,
    error: mocks.logError,
    withUser: mocks.withUser,
  }),
  generateRequestId: () => 'req_test',
}));

import { POST } from '@/app/api/family/dissolve/route';
import { getSupabaseAdmin } from '@/lib/supabase/server';

const REP_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const ADULT_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const TEEN_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';
const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const FAMILY_ID_UPPER = FAMILY_ID.toUpperCase();
const DISSOLVED_AT = '2026-10-19T05:00:00.123456+00:00';

const REP_EMAIL = 'rep@example.com';
const ADULT_EMAIL = 'adult@example.com';
const TEEN_EMAIL = 'teen@example.com';

const RPC_NAME = 'dissolve_family_by_representative';
/** auth.admin.listUsers() の既定の 50 件より多い、無関係のユーザーを先頭に並べる (#1204) */
const LEADING_USER_COUNT = 60;

type SentEmail = { to: string; subject: string; text: string; template: string };

function buildFake(): FakeServiceRole {
  return createFakeServiceRole({
    tables: {
      user_profiles: [
        { id: REP_ID, nickname: '花子' },
        { id: ADULT_ID, nickname: '太郎' },
        { id: TEEN_ID, nickname: null },
      ],
    },
    users: [
      ...leadingUsers(LEADING_USER_COUNT),
      { id: REP_ID, email: REP_EMAIL },
      { id: ADULT_ID, email: ADULT_EMAIL },
      { id: TEEN_ID, email: TEEN_EMAIL },
    ],
  });
}

const rpcSuccess = () => ({
  data: {
    scope_id: FAMILY_ID,
    scope_name: '山田家',
    dissolved_at: DISSOLVED_AT,
    member_user_ids: [REP_ID, ADULT_ID, TEEN_ID],
  },
  error: null,
});

let fake: FakeServiceRole;

beforeEach(() => {
  vi.clearAllMocks();
  // 本物のキーではないダミー値 (getSupabaseAdmin は環境変数の有無だけを見る)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');

  fake = buildFake();
  mocks.createServiceRoleClient.mockImplementation(() => fake.client);
  mocks.createClient.mockImplementation(async () => ({ auth: { getUser: mocks.getUser }, rpc: mocks.rpc }));
  mocks.getUser.mockResolvedValue({ data: { user: { id: REP_ID } }, error: null });
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name !== RPC_NAME) throw new Error(`unexpected rpc: ${name}`);
    fake.events.push(`rpc:${RPC_NAME}`);
    return rpcSuccess();
  });
  mocks.sendEmail.mockResolvedValue({ ok: true, id: 'email-1' });
  mocks.withUser.mockImplementation(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.logWarn,
    error: mocks.logError,
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const postRequest = (rawBody: string) =>
  new NextRequest('http://localhost/api/family/dissolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  });

const call = (body: unknown = { family_id: FAMILY_ID, confirm: true }) => POST(postRequest(JSON.stringify(body)));

const sentEmails = () => mocks.sendEmail.mock.calls.map(([envelope]) => envelope as SentEmail);

describe('POST /api/family/dissolve: 入口 (#1917)', () => {
  it('未ログインは 401 NOT_AUTHENTICATED。RPC を呼ばない', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await call();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['JSON でない本文', 'not json'],
    ['confirm が無い', JSON.stringify({ family_id: FAMILY_ID })],
    ['confirm が false', JSON.stringify({ family_id: FAMILY_ID, confirm: false })],
    ['confirm が文字列の true', JSON.stringify({ family_id: FAMILY_ID, confirm: 'true' })],
    ['family_id が UUID でない', JSON.stringify({ family_id: 'not-a-uuid', confirm: true })],
    ['family_id が無い', JSON.stringify({ confirm: true })],
  ])('本文が壊れている・confirm が無い・family_id が UUID でないときは 400 VALIDATION_ERROR。RPC を呼ばない (%s)', async (_label, raw) => {
    const res = await POST(postRequest(raw));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'VALIDATION_ERROR', message: '入力の内容が正しくありません' } });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('NULL 文字を含む本文は 400 INVALID_CHARACTER (Supabase のクライアントを作らない)', async () => {
    const res = await call({ family_id: FAMILY_ID, confirm: true, note: 'a\u0000b' });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_CHARACTER' });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('POST /api/family/dissolve: RPC の失敗 (#1917)', () => {
  it.each([
    ['NOT_FAMILY_REPRESENTATIVE', 'P0001', 403],
    ['FAMILY_NOT_FOUND', 'P0001', 404],
    ['FAMILY_ALREADY_DISSOLVED', 'P0001', 409],
  ] as const)('RPC の %s は %s → %i。本文に生のエラー文を入れない', async (code, pgCode, status) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: `${code} (raw detail)`, code: pgCode } });

    const res = await call();

    expect(res.status).toBe(status);
    const json = await res.json();
    expect(json).toEqual({ error: { code, message: '家族グループの解散に失敗しました' } });
    expect(JSON.stringify(json)).not.toContain('raw detail');
    expect(sentEmails()).toHaveLength(0);
  });

  it('40P01 (デッドロック) は 409 CONFLICT_RETRY', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'deadlock detected', code: '40P01' } });

    const res = await call();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'CONFLICT_RETRY', message: '家族グループの解散に失敗しました' } });
  });

  it('RPC の想定外の失敗と、戻り値の形が違うときは internalError (汎用の 500。段階・request_id を本文に出さない)', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'connection reset by peer', code: '08006' } });
    const failed = await call();
    expect(failed.status).toBe(500);
    const failedJson = await failed.json();
    expect(failedJson).toEqual({ error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました' } });
    expect(JSON.stringify(failedJson)).not.toMatch(/connection reset|req_test|request_id|stage/);

    mocks.rpc.mockResolvedValueOnce({ data: { scope_id: FAMILY_ID }, error: null });
    const malformed = await call();
    expect(malformed.status).toBe(500);
    expect(await malformed.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました' } });
    expect(sentEmails()).toHaveLength(0);
  });
});

describe('POST /api/family/dissolve: 成功と通知 (#1917)', () => {
  it('成功: RPC に p_family_id (小文字にそろえた) だけを渡し、200 { data: { family_id, dissolved_at } }。応答に member_user_ids もメールアドレスも入れない', async () => {
    const res = await call({ family_id: FAMILY_ID_UPPER, confirm: true });

    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(RPC_NAME, { p_family_id: FAMILY_ID });
    const json = await res.json();
    expect(json).toEqual({ data: { family_id: FAMILY_ID, dissolved_at: DISSOLVED_AT } });
    expect(JSON.stringify(json)).not.toContain('member_user_ids');
    expect(JSON.stringify(json)).not.toContain('@example.com');
  });

  it('成功: RPC が返した member_user_ids の全員 (本人を含む) に 1 通ずつ、家族名つきの文面で送る。宛先は auth.users から引く (先頭 50 件より後ろでも)。user_profiles から email を読まない', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(sentEmails().map((e) => e.to).sort()).toEqual([REP_EMAIL, ADULT_EMAIL, TEEN_EMAIL].sort());
    for (const envelope of sentEmails()) {
      expect(envelope.template).toBe('self_dissolve');
      expect(envelope.subject).toContain('山田家');
      expect(envelope.text).toContain('代表者により解散されました');
    }
    expect(sentEmails().find((e) => e.to === REP_EMAIL)?.text).toContain('花子 様');
    // 名前の無い人はアドレスを宛名にする
    expect(sentEmails().find((e) => e.to === TEEN_EMAIL)?.text).toContain(`${TEEN_EMAIL} 様`);
    expect(fake.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById.mock.calls.map(([id]) => id).sort()).toEqual([REP_ID, ADULT_ID, TEEN_ID].sort());
    const profileSelects = fake.selects.filter((s) => s.table === 'user_profiles').map((s) => s.columns ?? '');
    expect(profileSelects.length).toBeGreaterThan(0);
    for (const columns of profileSelects) expect(columns).not.toContain('email');
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('通知先の解決・送信が失敗しても 200。ログに宛先のアドレスを残さない', async () => {
    fake.authFailures.add(ADULT_ID);
    mocks.sendEmail.mockImplementation(async (envelope: SentEmail) => {
      if (envelope.to === TEEN_EMAIL) throw new EmailSendError('resend down');
      return { ok: true, id: 'email-1' };
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.logWarn).toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalled();
    const logged = JSON.stringify([...mocks.logWarn.mock.calls, ...mocks.logError.mock.calls]);
    expect(logged).not.toContain('@example.com');
  });

  it('service_role の client を作る処理が例外を投げても 200 (通知は best-effort)', async () => {
    mocks.createServiceRoleClient.mockImplementation(() => {
      throw new Error('admin client unavailable');
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(sentEmails()).toHaveLength(0);
    expect(mocks.logError).toHaveBeenCalled();
  });

  it('service_role の client は RPC の成功のあとにだけ作る (401・400・RPC の失敗では作らない)', async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    await call();
    await POST(postRequest('not json'));
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'NOT_FAMILY_REPRESENTATIVE', code: 'P0001' } });
    await call();
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();

    await call();
    expect(getSupabaseAdmin).toHaveBeenCalled();
    const rpcAt = fake.events.indexOf(`rpc:${RPC_NAME}`);
    const firstAuth = fake.events.findIndex((event) => event.startsWith('auth:') || event.startsWith('read:'));
    expect(rpcAt).toBeGreaterThan(-1);
    expect(firstAuth).toBeGreaterThan(rpcAt);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { EmailSendError } from '@/lib/emails/send-result';
import { createFakeServiceRole, leadingUsers, type FakeServiceRole } from '../operator/membership/fake-service-role';

// POST /api/org/dissolve — オーナーが自分の組織を解散する (#1917。docs/design/family/11-self-dissolve.md §14.2・§21.1)。
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

import { POST } from '@/app/api/org/dissolve/route';
import { getSupabaseAdmin } from '@/lib/supabase/server';

const OWNER_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const ADMIN_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const MEMBER_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';
const ORG_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const ORG_ID_UPPER = ORG_ID.toUpperCase();
const DISSOLVED_AT = '2026-10-19T05:00:00.123456+00:00';

const OWNER_EMAIL = 'owner@example.com';
const ADMIN_EMAIL = 'admin@example.com';
const MEMBER_EMAIL = 'member@example.com';

const RPC_NAME = 'dissolve_org_by_owner';
/** auth.admin.listUsers() の既定の 50 件より多い、無関係のユーザーを先頭に並べる (#1204) */
const LEADING_USER_COUNT = 60;

type SentEmail = { to: string; subject: string; text: string; template: string };

function buildFake(): FakeServiceRole {
  return createFakeServiceRole({
    tables: {
      user_profiles: [
        { id: OWNER_ID, nickname: '花子' },
        { id: ADMIN_ID, nickname: '太郎' },
        { id: MEMBER_ID, nickname: null },
      ],
    },
    users: [
      ...leadingUsers(LEADING_USER_COUNT),
      { id: OWNER_ID, email: OWNER_EMAIL },
      { id: ADMIN_ID, email: ADMIN_EMAIL },
      { id: MEMBER_ID, email: MEMBER_EMAIL },
    ],
  });
}

const rpcSuccess = () => ({
  data: {
    scope_id: ORG_ID,
    scope_name: '株式会社ほめゴハン',
    dissolved_at: DISSOLVED_AT,
    member_user_ids: [OWNER_ID, ADMIN_ID, MEMBER_ID],
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
  mocks.getUser.mockResolvedValue({ data: { user: { id: OWNER_ID } }, error: null });
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
  new NextRequest('http://localhost/api/org/dissolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  });

const call = (body: unknown = { organization_id: ORG_ID, confirm: true }) => POST(postRequest(JSON.stringify(body)));

const sentEmails = () => mocks.sendEmail.mock.calls.map(([envelope]) => envelope as SentEmail);

describe('POST /api/org/dissolve: 入口 (#1917)', () => {
  it('未ログインは 401 NOT_AUTHENTICATED。RPC を呼ばない', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await call();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['JSON でない本文', 'not json'],
    ['confirm が無い', JSON.stringify({ organization_id: ORG_ID })],
    ['confirm が false', JSON.stringify({ organization_id: ORG_ID, confirm: false })],
    ['confirm が文字列の true', JSON.stringify({ organization_id: ORG_ID, confirm: 'true' })],
    ['organization_id が UUID でない', JSON.stringify({ organization_id: 'not-a-uuid', confirm: true })],
    ['organization_id が無い', JSON.stringify({ confirm: true })],
  ])('本文が壊れている・confirm が無い・organization_id が UUID でないときは 400 VALIDATION_ERROR。RPC を呼ばない (%s)', async (_label, raw) => {
    const res = await POST(postRequest(raw));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'VALIDATION_ERROR', message: '入力の内容が正しくありません' } });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('NULL 文字を含む本文は 400 INVALID_CHARACTER (Supabase のクライアントを作らない)', async () => {
    const res = await call({ organization_id: ORG_ID, confirm: true, note: 'a\u0000b' });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_CHARACTER' });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('POST /api/org/dissolve: RPC の失敗 (#1917)', () => {
  it.each([
    ['NOT_ORG_OWNER', 'P0001', 403],
    ['ORG_NOT_FOUND', 'P0001', 404],
    ['ORG_ALREADY_DISSOLVED', 'P0001', 409],
  ] as const)('RPC の %s は %s → %i。本文に生のエラー文を入れない', async (code, pgCode, status) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: `${code} (raw detail)`, code: pgCode } });

    const res = await call();

    expect(res.status).toBe(status);
    const json = await res.json();
    expect(json).toEqual({ error: { code, message: '組織の解散に失敗しました' } });
    expect(JSON.stringify(json)).not.toContain('raw detail');
    expect(sentEmails()).toHaveLength(0);
  });

  it('40P01 (デッドロック) は 409 CONFLICT_RETRY', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'deadlock detected', code: '40P01' } });

    const res = await call();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'CONFLICT_RETRY', message: '組織の解散に失敗しました' } });
  });

  it('RPC の想定外の失敗と、戻り値の形が違うときは internalError (汎用の 500。段階・request_id を本文に出さない)', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'connection reset by peer', code: '08006' } });
    const failed = await call();
    expect(failed.status).toBe(500);
    const failedJson = await failed.json();
    expect(failedJson).toEqual({ error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました' } });
    expect(JSON.stringify(failedJson)).not.toMatch(/connection reset|req_test|request_id|stage/);

    mocks.rpc.mockResolvedValueOnce({ data: { scope_id: ORG_ID }, error: null });
    const malformed = await call();
    expect(malformed.status).toBe(500);
    expect(await malformed.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました' } });
    expect(sentEmails()).toHaveLength(0);
  });
});

describe('POST /api/org/dissolve: 成功と通知 (#1917)', () => {
  it('成功: RPC に p_organization_id (小文字にそろえた) だけを渡し、200 { data: { organization_id, dissolved_at } }。応答に member_user_ids もメールアドレスも入れない', async () => {
    const res = await call({ organization_id: ORG_ID_UPPER, confirm: true });

    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(RPC_NAME, { p_organization_id: ORG_ID });
    const json = await res.json();
    expect(json).toEqual({ data: { organization_id: ORG_ID, dissolved_at: DISSOLVED_AT } });
    expect(JSON.stringify(json)).not.toContain('member_user_ids');
    expect(JSON.stringify(json)).not.toContain('@example.com');
  });

  it('成功: RPC が返した member_user_ids の全員 (本人を含む) に 1 通ずつ、家族名つきの文面で送る。宛先は auth.users から引く (先頭 50 件より後ろでも)。user_profiles から email を読まない', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(sentEmails().map((e) => e.to).sort()).toEqual([OWNER_EMAIL, ADMIN_EMAIL, MEMBER_EMAIL].sort());
    for (const envelope of sentEmails()) {
      expect(envelope.template).toBe('self_dissolve');
      expect(envelope.subject).toContain('株式会社ほめゴハン');
      expect(envelope.text).toContain('オーナーにより解散されました');
    }
    expect(sentEmails().find((e) => e.to === OWNER_EMAIL)?.text).toContain('花子 様');
    // 名前の無い人はアドレスを宛名にする
    expect(sentEmails().find((e) => e.to === MEMBER_EMAIL)?.text).toContain(`${MEMBER_EMAIL} 様`);
    expect(fake.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById.mock.calls.map(([id]) => id).sort()).toEqual([OWNER_ID, ADMIN_ID, MEMBER_ID].sort());
    const profileSelects = fake.selects.filter((s) => s.table === 'user_profiles').map((s) => s.columns ?? '');
    expect(profileSelects.length).toBeGreaterThan(0);
    for (const columns of profileSelects) expect(columns).not.toContain('email');
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('通知先の解決・送信が失敗しても 200。ログに宛先のアドレスを残さない', async () => {
    fake.authFailures.add(ADMIN_ID);
    mocks.sendEmail.mockImplementation(async (envelope: SentEmail) => {
      if (envelope.to === MEMBER_EMAIL) throw new EmailSendError('outbox_failed', 'outbox down', null, 0, true);
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

  it('route は user_profiles の org_role を読まない (判定は RPC)', async () => {
    const sessionFrom = vi.fn();
    mocks.createClient.mockImplementation(async () => ({ auth: { getUser: mocks.getUser }, rpc: mocks.rpc, from: sessionFrom }));

    const res = await call();

    expect(res.status).toBe(200);
    expect(sessionFrom).not.toHaveBeenCalled();
    // service_role で読むのは通知の宛名 (id, nickname) だけ
    for (const select of fake.selects) expect(select.columns ?? '').not.toContain('org_role');
    const source = readFileSync(join(process.cwd(), 'src/app/api/org/dissolve/route.ts'), 'utf-8');
    expect(source.replace(/\/\/.*$/gm, '')).not.toContain('org_role');
  });

  it('service_role の client は RPC の成功のあとにだけ作る (401・400・RPC の失敗では作らない)', async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    await call();
    await POST(postRequest('not json'));
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'NOT_ORG_OWNER', code: 'P0001' } });
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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ErrorStatusMap, MembershipErrorCode } from '@/lib/errors/membership-errors';

// POST /api/org/invites/[id]/accept の応答 (Q-4: 解散した組織の招待の承諾)。
// accept_org_invite は、招待の組織が解散していると ORG_ALREADY_DISSOLVED (P0001) を RAISE する
// (supabase/migrations/20261022100000_org_invite_dissolved.sql)。route は RPC の生のエラー文を出さず (#1172)、
// コードと利用者向けの文で返す。画面 (src/app/invite/[token]/page.tsx) は出し分けの無いコードで本文の message をそのまま出す。
// 外部との境界 (Supabase) はモックにし、route 本体は実物を通す。

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc,
  }),
}));

import { POST } from '@/app/api/org/invites/[id]/accept/route';

const USER = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', email: 'invitee@example.com' };
const ORG_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const TOKEN = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
/** 解散した組織の招待を承諾したときの文 (route の ORG_INVITE_ACCEPT_MESSAGES と同じ文) */
const DISSOLVED_MESSAGE = 'この組織は解散しているため、招待を承諾できません。';
const FAILED_MESSAGE = '招待の承諾に失敗しました';

const call = () =>
  POST(new Request(`http://localhost/api/org/invites/${TOKEN}/accept`, { method: 'POST' }), {
    params: Promise.resolve({ id: TOKEN }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: USER }, error: null });
});

describe('POST /api/org/invites/[id]/accept', () => {
  it('Q-4: RPC が ORG_ALREADY_DISSOLVED なら 409 とコード、解散して承諾できないことの文を返す (RPC の生の文は出さない)', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'ORG_ALREADY_DISSOLVED', code: 'P0001' } });

    const res = await call();

    expect(mocks.rpc).toHaveBeenCalledWith('accept_org_invite', { p_token: TOKEN });
    expect(res.status).toBe(ErrorStatusMap[MembershipErrorCode.ORG_ALREADY_DISSOLVED]);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: MembershipErrorCode.ORG_ALREADY_DISSOLVED, message: DISSOLVED_MESSAGE },
    });
  });

  it('Q-4: 組織の行が無い (ORG_NOT_FOUND) ときは 404 と、これまでの固定の文', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'ORG_NOT_FOUND', code: 'P0001' } });

    const res = await call();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: MembershipErrorCode.ORG_NOT_FOUND, message: FAILED_MESSAGE } });
  });

  it('ほかの既知のコード (ALREADY_IN_ORG) は、これまでどおり固定の文 (画面はコードで出し分ける)', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'ALREADY_IN_ORG', code: 'P0001' } });

    const res = await call();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: MembershipErrorCode.ALREADY_IN_ORG, message: FAILED_MESSAGE } });
  });

  it('承諾できたら、所属した組織と役割を返す', async () => {
    mocks.rpc.mockResolvedValue({ data: { organization_id: ORG_ID, org_role: 'member' }, error: null });

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, organization_id: ORG_ID, role: 'member' });
  });

  it('未ログインは 401 で、RPC を呼ばない', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });

    const res = await call();

    expect(res.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

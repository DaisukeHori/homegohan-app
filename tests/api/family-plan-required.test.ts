/**
 * 家族の門 (billing/03 §6.6・§9.5) の route の写し (§14.1 のテスト 49)。
 * 家族グループの作成 (create_family_group)・招待の承諾 (accept_family_invite)・子供の追加 (add_family_child) の RPC が
 * FAMILY_PLAN_REQUIRED を RAISE したら、3 本の route は 402 と固定の文を返す (DB の生の文は出さない)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorStatusMap, MEMBERSHIP_ERROR_MESSAGES, MembershipErrorCode } from '@/lib/errors/membership-errors';

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), rpc: vi.fn() }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc,
    from: () => {
      throw new Error('the route must stop before reading tables when the RPC fails');
    },
  })),
}));
vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: () => ({ ...logger, withUser: () => logger }), generateRequestId: () => 'req-test' };
});
vi.mock('@/lib/emails/send', () => ({ sendEmail: vi.fn() }));

const { POST: groupsPOST } = await import('@/app/api/family/groups/route');
const { POST: acceptPOST } = await import('@/app/api/family/invites/[id]/accept/route');
const { POST: childPOST } = await import('@/app/api/family/members/child/route');

const USER = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', email: 'mom@example.com' };
const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const TOKEN = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
/** DB の RAISE の生の文 (応答に出してはいけない詳細を含む) */
const RAW_DB_MESSAGE = `FAMILY_PLAN_REQUIRED (family ${FAMILY_ID})`;

function post(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: USER }, error: null });
  mocks.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: RAW_DB_MESSAGE, details: FAMILY_ID } });
});

describe('billing/03 §9.5 FAMILY_PLAN_REQUIRED の写し', () => {
  it('the 3 family routes (groups, invite accept, child add) map FAMILY_PLAN_REQUIRED from the RPC to 402 with the fixed message', async () => {
    expect(ErrorStatusMap[MembershipErrorCode.FAMILY_PLAN_REQUIRED]).toBe(402);
    expect(MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.FAMILY_PLAN_REQUIRED]).toBe('家族プランのご契約が必要です。');
    const calls: Array<[string, () => Promise<Response>, string]> = [
      ['POST /api/family/groups', () => groupsPOST(post('/api/family/groups', { name: '山田家' })), 'create_family_group'],
      [
        'POST /api/family/invites/[id]/accept',
        () => acceptPOST(post(`/api/family/invites/${TOKEN}/accept`, { share_meals: true, share_health: false, share_menu: true }), { params: Promise.resolve({ id: TOKEN }) }),
        'accept_family_invite',
      ],
      [
        'POST /api/family/members/child',
        () => childPOST(post('/api/family/members/child', { family_id: FAMILY_ID, display_name: 'たろう', birth_date: '1956-01-01' })),
        'add_family_child',
      ],
    ];
    for (const [name, call, rpcName] of calls) {
      mocks.rpc.mockClear();
      const res = await call();
      expect(res.status, name).toBe(402);
      const text = await res.text();
      expect(JSON.parse(text), name).toEqual({ error: { code: 'FAMILY_PLAN_REQUIRED', message: '家族プランのご契約が必要です。' } });
      expect(text, name).not.toContain(FAMILY_ID);
      expect(mocks.rpc.mock.calls[0]?.[0], name).toBe(rpcName);
    }
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Supabase クライアントのモック
const mockGetUser = vi.fn();
const mockRpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
    rpc: mockRpc,
  }),
}));

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return actual;
});

const { POST } = await import('@/app/api/family/invites/[id]/accept/route');

const validUser = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', email: 'dad@example.com' };
const validToken = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const validBody = {
  share_meals: true,
  share_health: false,
  share_menu: true,
};

const makeParams = (token: string) => ({
  params: Promise.resolve({ id: token }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/family/invites/[token]/accept', () => {
  it('正常: 招待を承諾して family_id/member_id を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: validUser }, error: null });
    mockRpc.mockResolvedValue({
      data: {
        family_id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
        member_id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
        role: 'adult',
      },
      error: null,
    });

    const req = new Request(`http://localhost/api/family/invites/${validToken}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    const res = await POST(req, makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.family_id).toBeDefined();
    expect(json.data.member_id).toBeDefined();
    expect(json.data.role).toBe('adult');
  });

  it('未認証: 401 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });

    const req = new Request(`http://localhost/api/family/invites/${validToken}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    const res = await POST(req, makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe('NOT_AUTHENTICATED');
  });

  it('INVITE_EXPIRED: 410 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: validUser }, error: null });
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'INVITE_EXPIRED: invite has expired' },
    });

    const req = new Request(`http://localhost/api/family/invites/${validToken}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    const res = await POST(req, makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(410);
    expect(json.error.code).toBe('INVITE_EXPIRED');
  });

  it('ALREADY_IN_FAMILY: 409 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: validUser }, error: null });
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'ALREADY_IN_FAMILY: user already belongs to a family' },
    });

    const req = new Request(`http://localhost/api/family/invites/${validToken}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    const res = await POST(req, makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('ALREADY_IN_FAMILY');
  });

  it('INVITE_NOT_FOUND: 404 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: validUser }, error: null });
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'INVITE_NOT_FOUND: no matching invite' },
    });

    const req = new Request(`http://localhost/api/family/invites/${validToken}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    const res = await POST(req, makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe('INVITE_NOT_FOUND');
  });

  it('INVITE_EMAIL_MISMATCH: 403 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: validUser }, error: null });
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'INVITE_EMAIL_MISMATCH: email does not match' },
    });

    const req = new Request(`http://localhost/api/family/invites/${validToken}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    const res = await POST(req, makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('INVITE_EMAIL_MISMATCH');
  });

  it('share_settings のデフォルト値が適用される (body なし)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: validUser }, error: null });
    mockRpc.mockResolvedValue({
      data: {
        family_id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
        member_id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
        role: 'adult',
      },
      error: null,
    });

    const req = new Request(`http://localhost/api/family/invites/${validToken}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}), // デフォルト値を使用
    });

    const res = await POST(req, makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(200);
    // RPC 呼び出し確認: デフォルト値 (share_meals: true, share_health: false, share_menu: true)
    expect(mockRpc).toHaveBeenCalledWith('accept_family_invite', {
      p_token: validToken,
      p_share_meals: true,
      p_share_health: false,
      p_share_menu: true,
    });
  });
});

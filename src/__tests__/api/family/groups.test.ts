import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { MEMBERSHIP_ERROR_MESSAGES, MembershipErrorCode } from '@/lib/errors/membership-errors';

// Supabase クライアントのモック
const mockGetUser = vi.fn();
const mockRpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
    rpc: mockRpc,
  }),
}));

// next/server は実際のモジュールを使う
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return actual;
});

const { POST } = await import('@/app/api/family/groups/route');

const validUser = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', email: 'mom@example.com' };
const validBody = { name: '山田家' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/family/groups', () => {
  it('正常: 家族グループを作成して 201 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: validUser }, error: null });
    mockRpc.mockResolvedValue({
      data: { id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', name: '山田家', plan_key: 'free', member_limit: 4 },
      error: null,
    });

    const req = new Request('http://localhost/api/family/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data.family_group).toBeDefined();
  });

  it('POST /api/family/groups calls create_family_group with p_name only (no p_plan_key) and ignores plan_key in the body', async () => {
    mockGetUser.mockResolvedValue({ data: { user: validUser }, error: null });
    mockRpc.mockResolvedValue({
      data: { id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', name: '山田家', plan_key: 'free', member_limit: 4 },
      error: null,
    });

    // 古い画面・古い呼び出し元が plan_key を送ってきても 400 にならず、RPC にも渡らない (#1797 段 D)
    const res = await POST(
      new Request('http://localhost/api/family/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '山田家', plan_key: 'family_plus' }),
      }),
    );

    expect(res.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('create_family_group', { p_name: '山田家' });
    const [, args] = mockRpc.mock.calls[0];
    expect(Object.keys(args)).toEqual(['p_name']);
  });

  it('未認証: 401 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });

    const req = new Request('http://localhost/api/family/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe('NOT_AUTHENTICATED');
  });

  it('バリデーションエラー: name なし → 400', async () => {
    mockGetUser.mockResolvedValue({ data: { user: validUser }, error: null });

    const req = new Request('http://localhost/api/family/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_key: 'free' }), // name なし
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
  });

  it('ALREADY_IN_FAMILY: 409 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: validUser }, error: null });
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'ALREADY_IN_FAMILY: user already in a family group' },
    });

    const req = new Request('http://localhost/api/family/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('ALREADY_IN_FAMILY');
  });

  it('RPC 内部エラー: 500 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: validUser }, error: null });
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'internal server error' },
    });

    const req = new Request('http://localhost/api/family/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('RPC_FAILED');
  });
});

describe('POST /api/family/groups: 18 歳未満の本人 (#1173 T-MN1)', () => {
  it('RPC が MINOR_ACCOUNT_NOT_ALLOWED を含む文を返したら 403 { error: { code, message: MEMBERSHIP_ERROR_MESSAGES の文 } } で、DB の生の文を本文に出さない (S21)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: validUser }, error: null });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'MINOR_ACCOUNT_NOT_ALLOWED: caller user_profiles.birth_date is under 18' } });

    const res = await POST(
      new Request('http://localhost/api/family/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      }),
    );
    const text = await res.text();

    expect(res.status).toBe(403);
    expect(JSON.parse(text)).toEqual({
      error: { code: 'MINOR_ACCOUNT_NOT_ALLOWED', message: MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.MINOR_ACCOUNT_NOT_ALLOWED] },
    });
    expect(text).not.toContain('birth_date');
  });
});

describe('POST /api/family/groups: 退会の手続き中の本人 (#1917 の続き)', () => {
  it('RPC が REPRESENTATIVE_ACCOUNT_DELETING (P0001) を返したら 409 { error: { code, message: MEMBERSHIP_ERROR_MESSAGES の文 } } で、DB の生の文を本文に出さない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: validUser }, error: null });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'REPRESENTATIVE_ACCOUNT_DELETING', code: 'P0001' } });

    const res = await POST(
      new Request('http://localhost/api/family/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      }),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: 'REPRESENTATIVE_ACCOUNT_DELETING',
        message: MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING],
      },
    });
  });
});

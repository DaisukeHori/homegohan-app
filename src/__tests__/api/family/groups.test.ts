import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

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
const validBody = { name: '山田家', plan_key: 'free' };

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

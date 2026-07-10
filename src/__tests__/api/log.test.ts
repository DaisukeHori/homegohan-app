import { describe, it, expect, vi, beforeEach } from 'vitest';

// Supabase (認証チェック用) クライアントのモック
const mockGetUser = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
  }),
}));

// service_role クライアント (app_logs への insert) のモック
const mockInsert = vi.fn();
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: () => ({ insert: mockInsert }),
  })),
}));

const { POST } = await import('@/app/api/log/route');

const validUser = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' };

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockResolvedValue({ error: null });
  mockGetUser.mockResolvedValue({ data: { user: validUser }, error: null });
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
});

describe('POST /api/log (#1044 F6-20)', () => {
  it('正常なリクエストは 200 を返す', async () => {
    const res = await POST(makeRequest({ level: 'info', message: 'hello' }));
    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('level 未指定は 400 を返す', async () => {
    const res = await POST(makeRequest({ message: 'hello' }));
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('不正な level (enum 外) は 400 を返す', async () => {
    const res = await POST(makeRequest({ level: 'critical', message: 'hello' }));
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('2000文字を超える message は 400 を返す', async () => {
    const res = await POST(makeRequest({ level: 'info', message: 'a'.repeat(2001) }));
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('2000文字ちょうどの message は許可される', async () => {
    const res = await POST(makeRequest({ level: 'info', message: 'a'.repeat(2000) }));
    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('metadata 内の秘密キーは *** でマスクされて保存される', async () => {
    const res = await POST(
      makeRequest({
        level: 'info',
        message: 'login attempt',
        metadata: { password: 'p@ssw0rd', token: 'abc', note: 'ok' },
      }),
    );

    expect(res.status).toBe(200);
    const insertedArg = mockInsert.mock.calls[0][0];
    expect(insertedArg.metadata.password).toBe('***');
    expect(insertedArg.metadata.token).toBe('***');
    expect(insertedArg.metadata.note).toBe('ok');
  });

  it('巨大な metadata は切り詰められて保存される', async () => {
    const res = await POST(
      makeRequest({
        level: 'info',
        message: 'huge payload',
        metadata: { blob: 'x'.repeat(20_000) },
      }),
    );

    expect(res.status).toBe(200);
    const insertedArg = mockInsert.mock.calls[0][0];
    expect(insertedArg.metadata._truncated).toBe(true);
  });

  it('未認証リクエストは 401 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });
    const res = await POST(makeRequest({ level: 'info', message: 'hello' }));
    expect(res.status).toBe(401);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

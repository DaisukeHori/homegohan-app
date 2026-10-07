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

// 構造化ログのモック (5xx は createLogger(...).withUser(user.id).error(...) で記録される)
const mockLogError = vi.fn();
const mockWithUser = vi.fn(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: mockLogError,
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser: mockWithUser,
  })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

// next/server は実際のモジュールを使う
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return actual;
});

const { POST } = await import('@/app/api/family/promotions/[token]/reject/route');

const validUser = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', email: 'taro@example.com' };
// 承認リンクの token は gen_random_uuid() を 2 つ連結した 64 文字の小文字 16 進
const validToken = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

// reject_child_promotion RPC は family_promotion_requests の全行を返す (token を含む)
const rejectedRow = {
  id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  family_id: 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66',
  member_id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
  email: 'taro@example.com',
  token: 'c'.repeat(64),
  status: 'rejected',
  requested_by: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44',
  expires_at: '2026-10-21T02:00:00.000Z',
  created_at: '2026-10-07T02:00:00.000Z',
  resolved_at: '2026-10-08T02:00:00.000Z',
  resolved_by: validUser.id,
};

const makeParams = (token: string) => ({
  params: Promise.resolve({ token }),
});

const postRequest = (token: string) =>
  new Request(`http://localhost/api/family/promotions/${token}/reject`, {
    method: 'POST',
  });

// PostgREST が返す RPC エラー (RAISE EXCEPTION '<CODE>' USING ERRCODE = 'P0001' 相当)
const rpcError = (message: string, code = 'P0001') => ({
  data: null,
  error: { message, code },
});

beforeEach(() => {
  vi.clearAllMocks();
  // 既定は認証済み。未認証ケースは各テストで上書きする
  mockGetUser.mockResolvedValue({ data: { user: validUser }, error: null });
  // 前のテストの戻り値を持ち越さない
  mockRpc.mockReset();
});

describe('POST /api/family/promotions/[token]/reject', () => {
  it('未認証: 401 NOT_AUTHENTICATED を返し RPC を呼ばない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });

    const res = await POST(postRequest(validToken), makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe('NOT_AUTHENTICATED');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['63 文字 (1 文字不足)', validToken.slice(0, 63)],
    ['65 文字 (1 文字超過)', `${validToken}a`],
    ['大文字の 16 進 64 文字', validToken.toUpperCase()],
    ['16 進以外の文字を含む 64 文字', 'z'.repeat(64)],
  ])('token の形式が不正 (%s): 400 VALIDATION_ERROR を返し RPC を呼ばない', async (_label, badToken) => {
    const res = await POST(postRequest(badToken), makeParams(badToken));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('PROMOTION_REQUEST_NOT_FOUND: 404 を返す (4xx は構造化ログに記録しない)', async () => {
    mockRpc.mockResolvedValue(rpcError('PROMOTION_REQUEST_NOT_FOUND'));

    const res = await POST(postRequest(validToken), makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe('PROMOTION_REQUEST_NOT_FOUND');
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('PROMOTION_EMAIL_MISMATCH: 403 を返す (EMAIL_MISMATCH に化けない)', async () => {
    mockRpc.mockResolvedValue(rpcError('PROMOTION_EMAIL_MISMATCH'));

    const res = await POST(postRequest(validToken), makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('PROMOTION_EMAIL_MISMATCH');
  });

  it('PROMOTION_REQUEST_ALREADY_USED: 409 を返す', async () => {
    mockRpc.mockResolvedValue(rpcError('PROMOTION_REQUEST_ALREADY_USED'));

    const res = await POST(postRequest(validToken), makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('PROMOTION_REQUEST_ALREADY_USED');
  });

  it('deadlock detected (SQLSTATE 40P01): 409 CONFLICT_RETRY を返す', async () => {
    mockRpc.mockResolvedValue(rpcError('deadlock detected', '40P01'));

    const res = await POST(postRequest(validToken), makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('CONFLICT_RETRY');
    // 再試行可能な競合は 5xx ではないので構造化ログには残さない
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('未知の RPC エラー: 500 UNKNOWN を返し、token を含めずに構造化ログへ記録する', async () => {
    const dbError = { message: 'connection to server was lost', code: '08006' };
    mockRpc.mockResolvedValue({ data: null, error: dbError });

    const res = await POST(postRequest(validToken), makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('UNKNOWN');
    expect(mockWithUser).toHaveBeenCalledWith(validUser.id);
    expect(mockLogError).toHaveBeenCalledWith('reject_child_promotion failed', dbError, {
      pg_code: '08006',
    });
    // token は同意の証跡なのでログにも残さない
    expect(JSON.stringify(mockLogError.mock.calls)).not.toContain(validToken);
    expect(JSON.stringify(json)).not.toContain('connection to server');
  });

  it('正常: 拒否したリクエストの id と status だけを返し、RPC の全行 (token を含む) は返さない', async () => {
    mockRpc.mockResolvedValue({ data: rejectedRow, error: null });

    const res = await POST(postRequest(validToken), makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('reject_child_promotion', { p_token: validToken });
    expect(Object.keys(json)).toEqual(['data']);
    expect(Object.keys(json.data).sort()).toEqual(['request_id', 'status']);
    expect(json.data.request_id).toBe(rejectedRow.id);
    expect(json.data.status).toBe('rejected');
    expect(json.data).not.toHaveProperty('token');
    expect(JSON.stringify(json)).not.toContain(rejectedRow.token);
  });
});

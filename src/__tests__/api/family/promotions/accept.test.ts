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

const { POST } = await import('@/app/api/family/promotions/[token]/accept/route');

const validUser = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', email: 'taro@example.com' };
// 承認リンクの token は gen_random_uuid() を 2 つ連結した 64 文字の小文字 16 進
const validToken = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

// accept_child_promotion RPC は family_members の全行を返す (主キーは id)
const memberRow = {
  id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
  family_id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  user_id: validUser.id,
  role: 'adult',
  display_name: 'たろう',
  relationship: '長男',
  tags: [],
  share_meals: true,
  share_health: false,
  share_menu: true,
  child_profile: null,
  avatar_color: '#FF6B6B',
  status: 'active',
  joined_at: '2026-10-08T02:00:00.000Z',
  removed_at: null,
};

const makeParams = (token: string) => ({
  params: Promise.resolve({ token }),
});

const postRequest = (token: string, body?: unknown) =>
  new Request(`http://localhost/api/family/promotions/${token}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
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

describe('POST /api/family/promotions/[token]/accept', () => {
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

  it('body の share_meals が真偽値でない ("yes"): 400 VALIDATION_ERROR を返し RPC を呼ばない', async () => {
    const res = await POST(postRequest(validToken, { share_meals: 'yes' }), makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(json.error.details).toHaveProperty('share_meals');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['share_health', 1],
    ['share_menu', null],
  ])('body の %s が真偽値でない: 400 VALIDATION_ERROR を返し RPC を呼ばない', async (key, value) => {
    const res = await POST(postRequest(validToken, { [key]: value }), makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(json.error.details).toHaveProperty(key);
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

  it('PROMOTION_REQUEST_EXPIRED: 410 を返す', async () => {
    mockRpc.mockResolvedValue(rpcError('PROMOTION_REQUEST_EXPIRED'));

    const res = await POST(postRequest(validToken), makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(410);
    expect(json.error.code).toBe('PROMOTION_REQUEST_EXPIRED');
  });

  it('PROMOTION_REQUEST_ALREADY_USED: 409 を返す', async () => {
    mockRpc.mockResolvedValue(rpcError('PROMOTION_REQUEST_ALREADY_USED'));

    const res = await POST(postRequest(validToken), makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('PROMOTION_REQUEST_ALREADY_USED');
  });

  it('PROMOTION_EMAIL_MISMATCH: 403 を返す (EMAIL_MISMATCH に化けない)', async () => {
    mockRpc.mockResolvedValue(rpcError('PROMOTION_EMAIL_MISMATCH'));

    const res = await POST(postRequest(validToken), makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('PROMOTION_EMAIL_MISMATCH');
  });

  it('ALREADY_IN_FAMILY: 409 を返す', async () => {
    mockRpc.mockResolvedValue(rpcError('ALREADY_IN_FAMILY'));

    const res = await POST(postRequest(validToken), makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('ALREADY_IN_FAMILY');
  });

  it('ALREADY_PROMOTED: 409 を返す', async () => {
    mockRpc.mockResolvedValue(rpcError('ALREADY_PROMOTED'));

    const res = await POST(postRequest(validToken), makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('ALREADY_PROMOTED');
  });

  it('PROMOTION_MEMBER_UNAVAILABLE: 409 を返す', async () => {
    mockRpc.mockResolvedValue(rpcError('PROMOTION_MEMBER_UNAVAILABLE'));

    const res = await POST(postRequest(validToken), makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('PROMOTION_MEMBER_UNAVAILABLE');
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

  it('RPC が正規化した CONFLICT_RETRY (SQLSTATE P0001): 409 CONFLICT_RETRY を返す', async () => {
    mockRpc.mockResolvedValue(rpcError('CONFLICT_RETRY', 'P0001'));

    const res = await POST(postRequest(validToken), makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('CONFLICT_RETRY');
  });

  it('未知の RPC エラー: 500 UNKNOWN を返し、token を含めずに構造化ログへ記録する', async () => {
    const dbError = { message: 'connection to server was lost', code: '08006' };
    mockRpc.mockResolvedValue({ data: null, error: dbError });

    const res = await POST(postRequest(validToken), makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('UNKNOWN');
    expect(mockWithUser).toHaveBeenCalledWith(validUser.id);
    expect(mockLogError).toHaveBeenCalledWith('accept_child_promotion failed', dbError, {
      pg_code: '08006',
    });
    // token は同意の証跡なのでログにも残さない
    expect(JSON.stringify(mockLogError.mock.calls)).not.toContain(validToken);
    expect(JSON.stringify(json)).not.toContain('connection to server');
  });

  it('share_settings のデフォルト値が適用される (body なし)', async () => {
    mockRpc.mockResolvedValue({ data: memberRow, error: null });

    const res = await POST(postRequest(validToken), makeParams(validToken));

    expect(res.status).toBe(200);
    // RPC 呼び出し確認: デフォルト値 (share_meals: true, share_health: false, share_menu: true)
    expect(mockRpc).toHaveBeenCalledWith('accept_child_promotion', {
      p_token: validToken,
      p_share_meals: true,
      p_share_health: false,
      p_share_menu: true,
    });
  });

  it('share_settings のデフォルト値が適用される (body が空オブジェクト)', async () => {
    mockRpc.mockResolvedValue({ data: memberRow, error: null });

    const res = await POST(postRequest(validToken, {}), makeParams(validToken));

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('accept_child_promotion', {
      p_token: validToken,
      p_share_meals: true,
      p_share_health: false,
      p_share_menu: true,
    });
  });

  it('明示した共有設定がそのまま RPC に渡る', async () => {
    mockRpc.mockResolvedValue({ data: memberRow, error: null });

    const res = await POST(
      postRequest(validToken, { share_meals: false, share_health: true, share_menu: false }),
      makeParams(validToken),
    );

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('accept_child_promotion', {
      p_token: validToken,
      p_share_meals: false,
      p_share_health: true,
      p_share_menu: false,
    });
  });

  it('共有設定を一部だけ指定した場合、残りにはデフォルト値が適用される', async () => {
    mockRpc.mockResolvedValue({ data: memberRow, error: null });

    const res = await POST(postRequest(validToken, { share_health: true }), makeParams(validToken));

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('accept_child_promotion', {
      p_token: validToken,
      p_share_meals: true,
      p_share_health: true,
      p_share_menu: true,
    });
  });

  it('正常: family_members の全行ではなく {family_id, member_id, role} だけを返す', async () => {
    mockRpc.mockResolvedValue({ data: memberRow, error: null });

    const res = await POST(postRequest(validToken), makeParams(validToken));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(json)).toEqual(['data']);
    expect(Object.keys(json.data).sort()).toEqual(['family_id', 'member_id', 'role']);
    expect(json.data.family_id).toBe(memberRow.family_id);
    // RPC が返す family_members.id を member_id にマップすること
    expect(json.data.member_id).toBe(memberRow.id);
    expect(json.data.role).toBe('adult');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// メール送信のモック (実際には送らない)
const mockSendEmail = vi.fn();

vi.mock('@/lib/emails/send', () => ({
  sendEmail: mockSendEmail,
}));

// 同意依頼メールの文面生成は実装をそのまま通し、呼び出し引数を観測できるようスパイにする
vi.mock('@/lib/emails/membership/family-promote', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/emails/membership/family-promote')>();
  return { ...actual, renderFamilyPromoteEmail: vi.fn(actual.renderFamilyPromoteEmail) };
});

// next/server は実際のモジュールを使う
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return actual;
});

const { POST, DELETE } = await import('@/app/api/family/members/[member_id]/promote/route');
const { renderFamilyPromoteEmail } = await import('@/lib/emails/membership/family-promote');

const validUser = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', email: 'mom@example.com' };
const memberId = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';
const childEmail = 'taro@example.com';
const promotionToken = 'a'.repeat(64);
const expiresAt = '2026-10-21T02:00:00.000Z';

// request_child_promotion RPC の戻り値 (JSONB)。token はメール本文にだけ載せ、HTTP レスポンスには含めない。
const rpcResult = {
  id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  family_id: 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66',
  member_id: memberId,
  member_display_name: 'たろう',
  family_name: '山田家',
  email: childEmail,
  token: promotionToken,
  status: 'pending',
  expires_at: expiresAt,
  requester_name: '山田花子',
};

// revoke_child_promotion RPC の戻り値 (family_promotion_requests の全行。token を含む)
const revokedRow = {
  id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  family_id: 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66',
  member_id: memberId,
  email: childEmail,
  token: 'b'.repeat(64),
  status: 'revoked',
  requested_by: validUser.id,
  expires_at: expiresAt,
  created_at: '2026-10-07T02:00:00.000Z',
  resolved_at: '2026-10-08T02:00:00.000Z',
  resolved_by: validUser.id,
};

const makeParams = (id: string) => ({
  params: Promise.resolve({ member_id: id }),
});

const postRequest = (body?: unknown) =>
  new Request(`http://localhost/api/family/members/${memberId}/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const deleteRequest = () =>
  new Request(`http://localhost/api/family/members/${memberId}/promote`, {
    method: 'DELETE',
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
  // 前のテストの戻り値・例外を持ち越さない
  mockRpc.mockReset();
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ id: 'email-1' });
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/family/members/[member_id]/promote', () => {
  it('未認証: 401 NOT_AUTHENTICATED を返し RPC を呼ばない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });

    const res = await POST(postRequest({ email: childEmail }), makeParams(memberId));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe('NOT_AUTHENTICATED');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('email が未指定: 400 VALIDATION_ERROR を返し RPC を呼ばない', async () => {
    const res = await POST(postRequest({}), makeParams(memberId));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(json.error.details).toHaveProperty('email');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['形式が不正な文字列', 'not-an-email'],
    ['空文字列', ''],
    ['文字列以外 (数値)', 12345],
  ])('email が不正 (%s): 400 VALIDATION_ERROR を返し RPC を呼ばない', async (_label, email) => {
    const res = await POST(postRequest({ email }), makeParams(memberId));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(json.error.details).toHaveProperty('email');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('body が JSON として読めない: 空オブジェクト扱いで 400 VALIDATION_ERROR を返し RPC を呼ばない', async () => {
    const req = new Request(`http://localhost/api/family/members/${memberId}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'this is not json',
    });

    const res = await POST(req, makeParams(memberId));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('NOT_FAMILY_ADULT: 403 を返す (4xx は構造化ログに記録しない)', async () => {
    mockRpc.mockResolvedValue(rpcError('NOT_FAMILY_ADULT'));

    const res = await POST(postRequest({ email: childEmail }), makeParams(memberId));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('NOT_FAMILY_ADULT');
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('ALREADY_PROMOTED: 409 を返す', async () => {
    mockRpc.mockResolvedValue(rpcError('ALREADY_PROMOTED'));

    const res = await POST(postRequest({ email: childEmail }), makeParams(memberId));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('ALREADY_PROMOTED');
  });

  it('PROMOTION_MEMBER_UNAVAILABLE: 409 を返す', async () => {
    mockRpc.mockResolvedValue(rpcError('PROMOTION_MEMBER_UNAVAILABLE'));

    const res = await POST(postRequest({ email: childEmail }), makeParams(memberId));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('PROMOTION_MEMBER_UNAVAILABLE');
  });

  it('deadlock detected (SQLSTATE 40P01): 409 CONFLICT_RETRY を返す', async () => {
    mockRpc.mockResolvedValue(rpcError('deadlock detected', '40P01'));

    const res = await POST(postRequest({ email: childEmail }), makeParams(memberId));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('CONFLICT_RETRY');
    // 再試行可能な競合は 5xx ではないので構造化ログには残さない
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('未知の RPC エラー: 500 UNKNOWN を返し、withUser(user.id).error で構造化ログに記録する', async () => {
    const dbError = { message: 'connection to server was lost', code: '08006' };
    mockRpc.mockResolvedValue({ data: null, error: dbError });

    const res = await POST(postRequest({ email: childEmail }), makeParams(memberId));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('UNKNOWN');
    expect(mockWithUser).toHaveBeenCalledWith(validUser.id);
    expect(mockLogError).toHaveBeenCalledWith('request_child_promotion failed', dbError, {
      member_id: memberId,
      pg_code: '08006',
    });
    // DB の内部エラー文言はクライアントへ返さない
    expect(JSON.stringify(json)).not.toContain('connection to server');
  });

  it('RPC が失敗したときは同意依頼メールを組み立ても送りもしない', async () => {
    mockRpc.mockResolvedValue(rpcError('NOT_FAMILY_ADULT'));

    await POST(postRequest({ email: childEmail }), makeParams(memberId));

    expect(renderFamilyPromoteEmail).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('正常: 参加リクエストを作成し、固定の 5 キーだけを返す', async () => {
    mockRpc.mockResolvedValue({ data: rpcResult, error: null });

    const res = await POST(postRequest({ email: childEmail }), makeParams(memberId));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('request_child_promotion', {
      p_member_id: memberId,
      p_email: childEmail,
    });
    expect(json.data.request).toEqual({
      id: rpcResult.id,
      member_id: memberId,
      email: childEmail,
      status: 'pending',
      expires_at: expiresAt,
    });
    // RPC の戻り値は family_id / 表示名 / requester_name / token も持つが、レスポンスには出さない
    expect(Object.keys(json.data.request).sort()).toEqual([
      'email',
      'expires_at',
      'id',
      'member_id',
      'status',
    ]);
    expect(Object.keys(json.data)).toEqual(['request']);
    expect(Object.keys(json)).toEqual(['data']);
  });

  it('token を HTTP レスポンスのどこにも含めない (メールで対象者本人にだけ届ける)', async () => {
    mockRpc.mockResolvedValue({ data: rpcResult, error: null });

    const res = await POST(postRequest({ email: childEmail }), makeParams(memberId));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.request).not.toHaveProperty('token');
    expect(JSON.stringify(json)).not.toContain(promotionToken);
  });

  it('正常: RPC の表示名と承認ページ URL (token 入り) で同意依頼メールを組み立てる', async () => {
    mockRpc.mockResolvedValue({ data: rpcResult, error: null });

    const res = await POST(postRequest({ email: childEmail }), makeParams(memberId));

    expect(res.status).toBe(200);
    expect(renderFamilyPromoteEmail).toHaveBeenCalledTimes(1);
    expect(renderFamilyPromoteEmail).toHaveBeenCalledWith({
      email_address: childEmail,
      family_name: '山田家',
      member_display_name: 'たろう',
      requester_name: '山田花子',
      accept_url: `https://app.example.test/family/promotions/${promotionToken}`,
      expires_at: expiresAt,
    });
  });

  it('NEXT_PUBLIC_APP_URL が未設定なら accept_url は https://homegohan.app を基点にする', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);
    mockRpc.mockResolvedValue({ data: rpcResult, error: null });

    await POST(postRequest({ email: childEmail }), makeParams(memberId));

    expect(renderFamilyPromoteEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        accept_url: `https://homegohan.app/family/promotions/${promotionToken}`,
      }),
    );
  });

  it('正常: 組み立てた同意依頼メールを対象者本人宛に 1 通だけ送る (token はメールにだけ載る)', async () => {
    mockRpc.mockResolvedValue({ data: rpcResult, error: null });

    await POST(postRequest({ email: childEmail }), makeParams(memberId));

    const envelope = vi.mocked(renderFamilyPromoteEmail).mock.results[0].value;
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(envelope);
    expect(envelope.to).toBe(childEmail);
    expect(envelope.text).toContain(`https://app.example.test/family/promotions/${promotionToken}`);
  });

  it('requester_name が null: 依頼者名に user.email をフォールバックする', async () => {
    mockRpc.mockResolvedValue({ data: { ...rpcResult, requester_name: null }, error: null });

    const res = await POST(postRequest({ email: childEmail }), makeParams(memberId));

    expect(res.status).toBe(200);
    expect(renderFamilyPromoteEmail).toHaveBeenCalledWith(
      expect.objectContaining({ requester_name: validUser.email }),
    );
  });

  it('requester_name が null で user.email も無い: 依頼者名は「家族の代表者」になる', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: validUser.id } }, error: null });
    mockRpc.mockResolvedValue({ data: { ...rpcResult, requester_name: null }, error: null });

    const res = await POST(postRequest({ email: childEmail }), makeParams(memberId));

    expect(res.status).toBe(200);
    expect(renderFamilyPromoteEmail).toHaveBeenCalledWith(
      expect.objectContaining({ requester_name: '家族の代表者' }),
    );
  });

  it('family_name / member_display_name が null: 既定の呼称で文面を組み立てる', async () => {
    mockRpc.mockResolvedValue({
      data: { ...rpcResult, family_name: null, member_display_name: null },
      error: null,
    });

    const res = await POST(postRequest({ email: childEmail }), makeParams(memberId));

    expect(res.status).toBe(200);
    expect(renderFamilyPromoteEmail).toHaveBeenCalledWith(
      expect.objectContaining({ family_name: '家族グループ', member_display_name: '子供メンバー' }),
    );
  });

  it('メール送信が例外を投げても 200 を返し、失敗を構造化ログに記録する', async () => {
    const emailError = new Error('EMAIL_SEND_FAILED: smtp is down');
    mockSendEmail.mockRejectedValue(emailError);
    mockRpc.mockResolvedValue({ data: rpcResult, error: null });

    const res = await POST(postRequest({ email: childEmail }), makeParams(memberId));
    const json = await res.json();

    // リクエスト自体は作成済み。メールは再リクエストで再送できる
    expect(res.status).toBe(200);
    expect(json.data.request.id).toBe(rpcResult.id);
    expect(json.data.request.status).toBe('pending');
    expect(mockWithUser).toHaveBeenCalledWith(validUser.id);
    expect(mockLogError).toHaveBeenCalledWith('promotion request email send failed', emailError, {
      member_id: memberId,
      request_id: rpcResult.id,
    });
    // ログにも token を載せない
    expect(JSON.stringify(mockLogError.mock.calls)).not.toContain(promotionToken);
    expect(JSON.stringify(json)).not.toContain(promotionToken);
  });
});

describe('DELETE /api/family/members/[member_id]/promote', () => {
  it('未認証: 401 NOT_AUTHENTICATED を返し RPC を呼ばない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });

    const res = await DELETE(deleteRequest(), makeParams(memberId));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe('NOT_AUTHENTICATED');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('NOT_FAMILY_ADULT: 403 を返す', async () => {
    mockRpc.mockResolvedValue(rpcError('NOT_FAMILY_ADULT'));

    const res = await DELETE(deleteRequest(), makeParams(memberId));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('NOT_FAMILY_ADULT');
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('PROMOTION_REQUEST_NOT_FOUND: 404 を返す', async () => {
    mockRpc.mockResolvedValue(rpcError('PROMOTION_REQUEST_NOT_FOUND'));

    const res = await DELETE(deleteRequest(), makeParams(memberId));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe('PROMOTION_REQUEST_NOT_FOUND');
  });

  it('deadlock detected (SQLSTATE 40P01): 409 CONFLICT_RETRY を返す', async () => {
    mockRpc.mockResolvedValue(rpcError('deadlock detected', '40P01'));

    const res = await DELETE(deleteRequest(), makeParams(memberId));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('CONFLICT_RETRY');
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('未知の RPC エラー: 500 UNKNOWN を返し、withUser(user.id).error で構造化ログに記録する', async () => {
    const dbError = { message: 'connection to server was lost', code: '08006' };
    mockRpc.mockResolvedValue({ data: null, error: dbError });

    const res = await DELETE(deleteRequest(), makeParams(memberId));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('UNKNOWN');
    expect(mockWithUser).toHaveBeenCalledWith(validUser.id);
    expect(mockLogError).toHaveBeenCalledWith('revoke_child_promotion failed', dbError, {
      member_id: memberId,
      pg_code: '08006',
    });
    expect(JSON.stringify(json)).not.toContain('connection to server');
  });

  it('正常: 取り消したリクエストの id と status だけを返し、RPC の全行 (token を含む) は返さない', async () => {
    mockRpc.mockResolvedValue({ data: revokedRow, error: null });

    const res = await DELETE(deleteRequest(), makeParams(memberId));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('revoke_child_promotion', { p_member_id: memberId });
    expect(Object.keys(json)).toEqual(['data']);
    expect(Object.keys(json.data).sort()).toEqual(['request_id', 'status']);
    expect(json.data.request_id).toBe(revokedRow.id);
    expect(json.data.status).toBe('revoked');
    expect(json.data).not.toHaveProperty('token');
    expect(JSON.stringify(json)).not.toContain(revokedRow.token);
  });
});

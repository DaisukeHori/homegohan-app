import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RateLimitCategory, RateLimitResult } from '@/lib/rate-limit';

// POST /api/org/owner-transfer/propose の譲渡提案メール送信回数制限 (#1163)

const mockGetUser = vi.fn();
const mockRpc = vi.fn();
const mockFrom = vi.fn();
const client = { auth: { getUser: mockGetUser }, rpc: mockRpc, from: mockFrom };

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => client),
}));

// 宛先ユーザーのメールアドレスを引く管理者クライアント (SUPABASE_SERVICE_ROLE_KEY がある場合だけ使われる)
const mockGetUserById = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth: { admin: { getUserById: mockGetUserById } } })),
}));

// limiter は部分モック: 本物の応答ビルダー (getRetryAfterSec など) は残し、checkRateLimit だけ差し替える
const mockCheckRateLimit = vi.fn();

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

const mockLogError = vi.fn();
const mockLogWarn = vi.fn();
const mockWithUser = vi.fn(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: mockLogWarn,
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

const mockSendEmail = vi.fn();

vi.mock('@/lib/emails/send', () => ({
  sendEmail: mockSendEmail,
}));

const { POST } = await import('@/app/api/org/owner-transfer/propose/route');

const owner = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', email: 'owner@example.com' };
const orgId = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const toUserId = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';
const proposalId = 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44';

const allow = (windowSec = 60): RateLimitResult => ({
  success: true,
  limit: 3,
  remaining: 2,
  reset: Date.now() + windowSec * 1000,
  windowSec,
});

const deny = (windowSec: number, retryInSec = 30): RateLimitResult => ({
  success: false,
  limit: 3,
  remaining: 0,
  reset: Date.now() + retryInSec * 1000,
  windowSec,
});

function limiter(overrides: Partial<Record<RateLimitCategory, RateLimitResult>>) {
  mockCheckRateLimit.mockImplementation(
    async (_key: string, category: RateLimitCategory) => overrides[category] ?? allow(),
  );
}

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  c.select = vi.fn(() => c);
  c.eq = vi.fn(() => c);
  c.single = vi.fn(async () => result);
  return c;
}

let profile: { organization_id: string | null; org_role: string | null; nickname: string | null };

const postRequest = (body: unknown) =>
  new Request('http://localhost/api/org/owner-transfer/propose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const validBody = { organization_id: orgId, to_user_id: toUserId };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  mockGetUser.mockResolvedValue({ data: { user: owner }, error: null });
  limiter({});

  profile = { organization_id: orgId, org_role: 'owner', nickname: '山田' };
  mockFrom.mockImplementation((table: string) => {
    if (table === 'user_profiles') return chain({ data: profile, error: null });
    if (table === 'organizations') return chain({ data: { name: 'テスト株式会社' }, error: null });
    throw new Error(`unexpected table: ${table}`);
  });

  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ data: proposalId, error: null });

  mockGetUserById.mockReset();
  mockGetUserById.mockResolvedValue({ data: { user: { email: 'next-owner@example.com' } } });

  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ id: 'email-1' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/org/owner-transfer/propose: 送信回数の制限 (#1163)', () => {
  it('上限内: 200 で proposal_id を返し、提案メールを 1 通だけ送る', async () => {
    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.proposal_id).toBe(proposalId);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe('next-owner@example.com');
  });

  it('提案者の user.id だけを鍵に判定する。リクエストの organization_id / to_user_id は鍵にしない', async () => {
    await POST(postRequest(validBody));

    expect(mockCheckRateLimit.mock.calls).toEqual([[owner.id, 'transfer-propose']]);
    expect(JSON.stringify(mockCheckRateLimit.mock.calls)).not.toContain(orgId);
    expect(JSON.stringify(mockCheckRateLimit.mock.calls)).not.toContain(toUserId);
  });

  it('分あたり上限を超過: 429 / 入れ子の RATE_LIMITED / Retry-After。RPC もメール送信も呼ばない', async () => {
    limiter({ 'transfer-propose': deny(60, 30) });

    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.code).toBe('RATE_LIMITED');
    expect(json.error.message).toBe('短時間に操作が集中しています。1分ほど待ってからお試しください。');
    expect(json.error.retryAfter).toBeGreaterThanOrEqual(29);
    expect(res.headers.get('Retry-After')).toBe(String(json.error.retryAfter));
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('日次上限を超過: 429 と「本日の上限」の文言', async () => {
    limiter({ 'transfer-propose': deny(24 * 60 * 60, 7200) });

    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.message).toBe('本日の送信上限に達しました。しばらく時間をおいてからお試しください。');
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(7000);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('超過したら withUser(user.id).warn に記録する', async () => {
    limiter({ 'transfer-propose': deny(60) });

    await POST(postRequest(validBody));

    expect(mockWithUser).toHaveBeenCalledWith(owner.id);
    expect(mockLogWarn.mock.calls[0][1]).toMatchObject({ flow: 'transfer-propose', layer: 'user' });
  });

  it('limiter のバックエンドが例外を投げたら伝播し (fail-closed)、RPC もメール送信も実行されない', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('ECONNREFUSED: upstash unreachable'));

    await expect(POST(postRequest(validBody))).rejects.toThrow('ECONNREFUSED');

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalled();
  });

  it('未認証 (401): limiter を呼ばない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('POST /api/org/owner-transfer/propose: 既存の挙動 (退行確認)', () => {
  it('owner でないユーザー (403): RPC もメール送信も呼ばない', async () => {
    profile = { organization_id: orgId, org_role: 'admin', nickname: null };

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('本文が不正 (400)', async () => {
    const res = await POST(postRequest({ organization_id: 'not-a-uuid' }));

    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('RPC が TARGET_NOT_IN_ORG: 404 を返し、メールは送らない', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'TARGET_NOT_IN_ORG' } });

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(404);
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

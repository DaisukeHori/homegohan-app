import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RateLimitCategory, RateLimitResult } from '@/lib/rate-limit';

// POST /api/family/representative-transfer/propose の譲渡提案メール送信回数制限 (#1163)

const mockGetUser = vi.fn();
const mockRpc = vi.fn();
const mockFrom = vi.fn();
// 宛先のメールアドレスは auth.users にしか無いので、service_role の Auth Admin API で引く (#1110)
const mockGetUserById = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
    rpc: mockRpc,
    from: mockFrom,
  }),
  getSupabaseAdmin: () => ({ auth: { admin: { getUserById: mockGetUserById } } }),
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

const { POST } = await import('@/app/api/family/representative-transfer/propose/route');

const rep = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', email: 'rep@example.com' };
const familyId = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
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

/** select(...) に渡された列の指定 (存在しない列を読んでいないかの確認に使う) */
const selects: Array<{ table: string; columns: string }> = [];

function chain(table: string, result: unknown) {
  const c: Record<string, unknown> = {};
  c.select = vi.fn((columns: string) => {
    selects.push({ table, columns });
    return c;
  });
  c.eq = vi.fn(() => c);
  c.single = vi.fn(async () => result);
  return c;
}

const postRequest = (body: unknown) =>
  new Request('http://localhost/api/family/representative-transfer/propose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const validBody = { family_id: familyId, to_user_id: toUserId };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: rep }, error: null });
  limiter({});

  selects.length = 0;
  mockFrom.mockImplementation((table: string) => {
    // 提案者本人の行 (RLS で読める)。user_profiles に email 列は無い
    if (table === 'user_profiles') return chain(table, { data: { nickname: '花子' }, error: null });
    if (table === 'family_groups') return chain(table, { data: { name: '山田家' }, error: null });
    throw new Error(`unexpected table: ${table}`);
  });

  mockGetUserById.mockReset();
  mockGetUserById.mockResolvedValue({ data: { user: { id: toUserId, email: 'next-rep@example.com' } }, error: null });

  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ data: proposalId, error: null });

  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ id: 'email-1' });
});

describe('POST /api/family/representative-transfer/propose: 送信回数の制限 (#1163)', () => {
  it('上限内: 201 で提案を返し、提案メールを 1 通だけ送る', async () => {
    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data.proposal).toBe(proposalId);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe('next-rep@example.com');
  });

  it('提案者の user.id だけを鍵に判定する。リクエストの family_id / to_user_id は鍵にしない', async () => {
    await POST(postRequest(validBody));

    expect(mockCheckRateLimit.mock.calls).toEqual([[rep.id, 'transfer-propose']]);
    expect(JSON.stringify(mockCheckRateLimit.mock.calls)).not.toContain(familyId);
    expect(JSON.stringify(mockCheckRateLimit.mock.calls)).not.toContain(toUserId);
  });

  it('分あたり上限を超過: 429 / 入れ子の RATE_LIMITED / Retry-After。RPC もメール送信も呼ばない', async () => {
    limiter({ 'transfer-propose': deny(60, 30) });

    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.code).toBe('RATE_LIMITED');
    expect(json.error.message).toBe('短時間に操作が集中しています。1分ほど待ってからお試しください。');
    expect(json.error.retryAfter).toBeGreaterThanOrEqual(20);
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

    expect(mockWithUser).toHaveBeenCalledWith(rep.id);
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

describe('POST /api/family/representative-transfer/propose: DB の 24 時間上限 (#1163)', () => {
  // enforce_membership_daily_cap が RAISE する RATE_LIMITED を、PostgREST が RPC のエラーとして返した形
  const dbRateLimited = (overrides: Record<string, unknown> = {}) => ({
    data: null,
    error: {
      message: 'RATE_LIMITED',
      code: 'P0001',
      details: 'transfer_propose:per_actor',
      hint: 'retry_after_sec=900',
      ...overrides,
    },
  });

  it('RPC が RATE_LIMITED: アプリ層の上限と同じ 429 / 入れ子の RATE_LIMITED / Retry-After (HINT の秒数) を返す', async () => {
    mockRpc.mockResolvedValue(dbRateLimited());

    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: '本日の送信上限に達しました。しばらく時間をおいてからお試しください。',
        retryAfter: 900,
      },
    });
    expect(res.headers.get('Retry-After')).toBe('900');
  });

  it('提案メールを送らず、宛先のメールアドレスも対象者のプロフィールも読みにいかない', async () => {
    mockRpc.mockResolvedValue(dbRateLimited());

    await POST(postRequest(validBody));

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('HINT が読めないときも 429 にする (Retry-After は 1 時間)', async () => {
    mockRpc.mockResolvedValue(dbRateLimited({ hint: null }));

    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.retryAfter).toBe(3600);
    expect(res.headers.get('Retry-After')).toBe('3600');
  });

  it('withUser(user.id).warn に flow=transfer-propose / layer=db / 上限名を記録する', async () => {
    mockRpc.mockResolvedValue(dbRateLimited());

    await POST(postRequest(validBody));

    expect(mockWithUser).toHaveBeenCalledWith(rep.id);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn.mock.calls[0][1]).toMatchObject({
      flow: 'transfer-propose',
      layer: 'db',
      rule: 'transfer_propose:per_actor',
      retry_after_sec: 900,
    });
  });
});

describe('POST /api/family/representative-transfer/propose: 提案メールの宛先 (#1110)', () => {
  // 修正前は宛先のメールアドレスを user_profiles.email から読んでいた。その列は無く (メールアドレスは
  // auth.users にしか無い)、読み取りは常に失敗するため、提案メールは 1 通も送られなかった。

  it('宛先のメールアドレスは Auth Admin API (getUserById) で提案先のユーザー 1 人だけを引いて取得する', async () => {
    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(201);
    expect(mockGetUserById.mock.calls).toEqual([[toUserId]]);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe('next-rep@example.com');
  });

  it('user_profiles からメールアドレスを読まない (その列は無い)', async () => {
    await POST(postRequest(validBody));

    const profileSelects = selects.filter(({ table }) => table === 'user_profiles');
    expect(profileSelects.length).toBeGreaterThan(0);
    for (const { columns } of profileSelects) {
      expect(columns).not.toMatch(/\bemail\b/);
    }
  });

  it('差出人の名前は提案者のニックネーム。提案者のメールアドレスを本文に載せない', async () => {
    await POST(postRequest({ ...validBody, reason: '転勤するため' }));

    const envelope = mockSendEmail.mock.calls[0][0];
    expect(envelope.text).toContain('代表者 花子 様から');
    expect(envelope.text).toContain('「山田家」');
    expect(envelope.text).toContain(`/family/transfer-accept/${proposalId}`);
    expect(envelope.text).toContain('転勤するため');
    expect(envelope.text).not.toContain(rep.email);
  });

  it('宛先のメールアドレスを取得できなくても 201 を返し、メールは送らず、警告ログに残す', async () => {
    mockGetUserById.mockResolvedValue({ data: { user: null }, error: { message: 'User not found', status: 404 } });

    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data.proposal).toBe(proposalId);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockWithUser).toHaveBeenCalledWith(rep.id);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn.mock.calls[0][1]).toMatchObject({ requested: 1, failed: 1, failed_user_ids: [toUserId] });
  });

  it('宛先がメールアドレスを持たない (電話番号のみなど) ときは送らず、失敗扱いにもしない', async () => {
    mockGetUserById.mockResolvedValue({ data: { user: { id: toUserId, email: null } }, error: null });

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(201);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockLogWarn).not.toHaveBeenCalled();
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('メール送信が失敗しても 201 を返し、構造化ログに残す (ログに宛先のメールアドレスは残さない)', async () => {
    const sendError = new Error('EMAIL_SEND_FAILED: temporarily unavailable');
    mockSendEmail.mockRejectedValue(sendError);

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(201);
    expect(mockWithUser).toHaveBeenCalledWith(rep.id);
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError).toHaveBeenCalledWith(expect.any(String), sendError, {
      family_id: familyId,
      to_user_id: toUserId,
    });
    expect(JSON.stringify(mockLogError.mock.calls)).not.toContain('@example.com');
  });

  it('RPC が失敗したときは、宛先のメールアドレスも探さない', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'NOT_FAMILY_REPRESENTATIVE' } });

    await POST(postRequest(validBody));

    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe('POST /api/family/representative-transfer/propose: 既存の挙動 (退行確認)', () => {
  it('family_id / to_user_id が無い (400): RPC を呼ばない', async () => {
    const res = await POST(postRequest({ family_id: familyId }));

    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('RPC が NOT_FAMILY_REPRESENTATIVE: 403 を返し、メールは送らない (Retry-After は付けない)', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'NOT_FAMILY_REPRESENTATIVE' } });

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(403);
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

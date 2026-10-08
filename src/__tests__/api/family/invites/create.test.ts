import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RateLimitCategory, RateLimitResult } from '@/lib/rate-limit';

// POST /api/family/invites の招待メール送信回数制限 (#1163)

// Supabase クライアントのモック
const mockGetUser = vi.fn();
const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
    rpc: mockRpc,
    from: mockFrom,
  }),
}));

// limiter は部分モック: 本物の応答ビルダー (getRetryAfterSec など) は残し、checkRateLimit だけ差し替える
const mockCheckRateLimit = vi.fn();

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

// 構造化ログのモック
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

// メール送信のモック (実際には送らない)
const mockSendEmail = vi.fn();

vi.mock('@/lib/emails/send', () => ({
  sendEmail: mockSendEmail,
}));

const { POST } = await import('@/app/api/family/invites/route');

const user = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', email: 'mom@example.com' };
const familyId = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const otherFamilyId = 'f1eebc99-9c0b-4ef8-bb6d-6bb9bd380a77';
const inviteeEmail = 'taro@example.com';
const inviteeHash = createHash('sha256').update(inviteeEmail).digest('hex').slice(0, 32);

const inviteRow = {
  id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  token: 'a'.repeat(64),
  expires_at: '2026-10-21T02:00:00.000Z',
};

const allow = (windowSec = 60): RateLimitResult => ({
  success: true,
  limit: 5,
  remaining: 4,
  reset: Date.now() + windowSec * 1000,
  windowSec,
});

const deny = (windowSec: number, retryInSec = 30): RateLimitResult => ({
  success: false,
  limit: 5,
  remaining: 0,
  reset: Date.now() + retryInSec * 1000,
  windowSec,
});

/** カテゴリごとに結果を差し替える。指定の無いカテゴリは通す */
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

const postRequest = (body: unknown) =>
  new Request('http://localhost/api/family/invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const validBody = { family_id: familyId, email: inviteeEmail };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user }, error: null });
  limiter({});

  mockFrom.mockImplementation((table: string) => {
    if (table === 'user_profiles') {
      return chain({ data: { family_id: familyId, nickname: '花子', display_name: null }, error: null });
    }
    if (table === 'family_groups') return chain({ data: { name: '山田家' }, error: null });
    throw new Error(`unexpected table: ${table}`);
  });

  mockRpc.mockReset();
  mockRpc.mockImplementation(async (fn: string) => {
    if (fn === 'create_family_invite') return { data: inviteRow, error: null };
    if (fn === 'get_invite_details') {
      return { data: { is_existing_user: false, invitee_display_name: null }, error: null };
    }
    throw new Error(`unexpected rpc: ${fn}`);
  });

  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ id: 'email-1' });
});

describe('POST /api/family/invites: 送信回数の制限 (#1163)', () => {
  it('上限内: 201 を返し、招待メールを 1 通だけ送る', async () => {
    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data.invite).toEqual(inviteRow);
    expect(mockRpc).toHaveBeenCalledWith('create_family_invite', {
      p_family_id: familyId,
      p_email: inviteeEmail,
      p_custom_message: null,
    });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe(inviteeEmail);
  });

  it('招待者 (user.id) と、所属を確認した家族 + 宛先ハッシュで判定する', async () => {
    await POST(postRequest(validBody));

    expect(mockCheckRateLimit.mock.calls).toEqual([
      [user.id, 'family-invite'],
      [`family-invite:${familyId}:${inviteeHash}`, 'invite-target'],
    ]);
    // 鍵にメールアドレスそのものを含めない
    for (const [key] of mockCheckRateLimit.mock.calls) {
      expect(key).not.toContain('@');
    }
  });

  it('宛先に大文字が含まれていても、小文字にそろえた宛先のハッシュで数える', async () => {
    const res = await POST(postRequest({ family_id: familyId, email: 'Taro@Example.com' }));

    expect(res.status).toBe(201);
    expect(mockCheckRateLimit.mock.calls[1]).toEqual([`family-invite:${familyId}:${inviteeHash}`, 'invite-target']);
  });

  it('招待者の分あたり上限を超過: 429 / 入れ子の RATE_LIMITED / Retry-After。RPC もメール送信も呼ばない', async () => {
    limiter({ 'family-invite': deny(60, 30) });

    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.code).toBe('RATE_LIMITED');
    expect(json.error.message).toBe('短時間に操作が集中しています。1分ほど待ってからお試しください。');
    expect(json.error.retryAfter).toBeGreaterThanOrEqual(20);
    expect(json.error.retryAfter).toBeLessThanOrEqual(30);
    expect(res.headers.get('Retry-After')).toBe(String(json.error.retryAfter));
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    // 招待者の枠で止まったら、宛先の枠は数えない
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
  });

  it('招待者の日次上限を超過: 429 と「本日の上限」の文言', async () => {
    limiter({ 'family-invite': deny(24 * 60 * 60, 7200) });

    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.code).toBe('RATE_LIMITED');
    expect(json.error.message).toBe('本日の送信上限に達しました。しばらく時間をおいてからお試しください。');
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(7000);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('宛先の上限だけを超過: 招待者の枠が残っていても 429。RPC もメール送信も呼ばない', async () => {
    limiter({ 'invite-target': deny(24 * 60 * 60, 3600) });

    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.code).toBe('RATE_LIMITED');
    expect(res.headers.get('Retry-After')).toBe(String(json.error.retryAfter));
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
  });

  it('429 の本文は UI が読む json.error.message を持つ (平らな AI 系の形式ではない)', async () => {
    limiter({ 'family-invite': deny(60) });

    const json = await (await POST(postRequest(validBody))).json();

    expect(typeof json.error).toBe('object');
    expect(typeof json.error.message).toBe('string');
    expect(json).not.toHaveProperty('code');
  });

  it('超過したら withUser(user.id).warn に記録する (メールアドレスは残さない)', async () => {
    limiter({ 'invite-target': deny(24 * 60 * 60) });

    await POST(postRequest(validBody));

    expect(mockWithUser).toHaveBeenCalledWith(user.id);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain('taro');
    expect(mockLogWarn.mock.calls[0][1]).toMatchObject({ flow: 'family-invite', layer: 'target' });
  });

  it('limiter のバックエンドが例外を投げたら伝播し (fail-closed)、RPC もメール送信も実行されない', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('ECONNREFUSED: upstash unreachable'));

    await expect(POST(postRequest(validBody))).rejects.toThrow('ECONNREFUSED');

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalled();
  });
});

describe('POST /api/family/invites: 検証済みでないリクエストでは limiter を使わない (#1163)', () => {
  it('未認証 (401): limiter も RPC も呼ばない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('JSON として読めない本文 (400): limiter を呼ばない', async () => {
    const res = await POST(postRequest('this is not json'));

    expect(res.status).toBe(400);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('入力値が不正 (400): limiter を呼ばない', async () => {
    const res = await POST(postRequest({ family_id: familyId, email: 'not-an-email' }));

    expect(res.status).toBe(400);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('他の家族の family_id を指定 (403): limiter を呼ばない = 他の家族の枠を鍵にしない', async () => {
    const res = await POST(postRequest({ family_id: otherFamilyId, email: inviteeEmail }));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('NOT_FAMILY_ADULT');
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    // どの呼び出しの鍵にも、リクエストで指定された他の家族の ID が現れない
    expect(JSON.stringify(mockCheckRateLimit.mock.calls)).not.toContain(otherFamilyId);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('家族に所属していないユーザー (403): limiter を呼ばない', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') return chain({ data: { family_id: null, nickname: null, display_name: null }, error: null });
      throw new Error(`unexpected table: ${table}`);
    });

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(403);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});

describe('POST /api/family/invites: 既存の挙動 (退行確認)', () => {
  it('RPC が ALREADY_IN_FAMILY: 409 を返し、メールは送らない', async () => {
    mockRpc.mockImplementation(async () => ({ data: null, error: { message: 'ALREADY_IN_FAMILY' } }));

    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('ALREADY_IN_FAMILY');
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('メール送信が失敗しても 201 を返す (招待は残る)', async () => {
    mockSendEmail.mockRejectedValue(new Error('smtp is down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(201);
    warn.mockRestore();
  });
});

import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RateLimitCategory, RateLimitResult } from '@/lib/rate-limit';

// POST /api/org/members (メンバー追加 = 組織への招待メール) の送信回数制限と入力検証 (#1163)
// /api/org/invites と createOrgInviteWithEmail を共有するため、こちらの入口からも回避できないことを確かめる。

const mockGetUser = vi.fn();
const mockRpc = vi.fn();
const mockFrom = vi.fn();
const client = { auth: { getUser: mockGetUser }, rpc: mockRpc, from: mockFrom };

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => client),
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

const { POST } = await import('@/app/api/org/members/route');

const actor = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', email: 'admin@example.com' };
const orgId = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const inviteeEmail = 'hanako@example.com';
const inviteeHash = createHash('sha256').update(inviteeEmail).digest('hex').slice(0, 32);

const inviteRow = {
  id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
  token: 'a'.repeat(64),
  email: inviteeEmail,
  invited_role: 'member',
  status: 'pending',
  expires_at: '2026-10-21T02:00:00.000Z',
  custom_message: null,
  organization_id: orgId,
};

const allow = (windowSec = 60): RateLimitResult => ({
  success: true,
  limit: 10,
  remaining: 9,
  reset: Date.now() + windowSec * 1000,
  windowSec,
});

const deny = (windowSec: number, retryInSec = 30): RateLimitResult => ({
  success: false,
  limit: 10,
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
let isExistingUser = true;

const postRequest = (body: unknown) =>
  new Request('http://localhost/api/org/members', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: actor }, error: null });
  limiter({});

  profile = { organization_id: orgId, org_role: 'admin', nickname: '管理者' };
  isExistingUser = true;
  mockFrom.mockImplementation((table: string) => {
    if (table === 'user_profiles') return chain({ data: profile, error: null });
    if (table === 'organizations') return chain({ data: { name: 'テスト株式会社' }, error: null });
    throw new Error(`unexpected table: ${table}`);
  });

  mockRpc.mockReset();
  mockRpc.mockImplementation(async (fn: string) => {
    if (fn === 'create_org_invite') return { data: inviteRow, error: null };
    if (fn === 'get_invite_details') return { data: { is_existing_user: isExistingUser }, error: null };
    throw new Error(`unexpected rpc: ${fn}`);
  });

  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ id: 'email-1' });
});

describe('POST /api/org/members: 送信回数の制限 (#1163)', () => {
  it('上限内: 201 を返し、招待メールを 1 通だけ送る (役割は member)', async () => {
    const res = await POST(postRequest({ email: inviteeEmail, nickname: '花子' }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.ok).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith('create_org_invite', {
      p_organization_id: orgId,
      p_email: inviteeEmail,
      p_role: 'member',
      p_custom_message: undefined,
    });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe(inviteeEmail);
  });

  it('/api/org/invites と同じ枠 (招待者 → 組織 → 宛先) で判定する', async () => {
    await POST(postRequest({ email: inviteeEmail }));

    expect(mockCheckRateLimit.mock.calls).toEqual([
      [actor.id, 'org-invite'],
      [orgId, 'org-invite-scope'],
      [`org-invite:${orgId}:${inviteeHash}`, 'invite-target'],
    ]);
  });

  it.each([
    ['招待者の分あたり', 'org-invite', 60, 1],
    ['組織全体の日次', 'org-invite-scope', 24 * 60 * 60, 2],
    ['宛先の日次', 'invite-target', 24 * 60 * 60, 3],
  ] as const)('%sの上限を超過: 429 / RATE_LIMITED / Retry-After。RPC もメール送信も呼ばない', async (_label, category, windowSec, calls) => {
    limiter({ [category]: deny(windowSec, 600) });

    const res = await POST(postRequest({ email: inviteeEmail }));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.code).toBe('RATE_LIMITED');
    expect(json.error.retryAfter).toBeGreaterThanOrEqual(590);
    expect(res.headers.get('Retry-After')).toBe(String(json.error.retryAfter));
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(calls);
  });

  it('limiter のバックエンドが例外を投げたら伝播し (fail-closed)、RPC もメール送信も実行されない', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('ECONNREFUSED: upstash unreachable'));

    await expect(POST(postRequest({ email: inviteeEmail }))).rejects.toThrow('ECONNREFUSED');

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe('POST /api/org/members: 認証・権限・入力の検証が先 (limiter を使わない)', () => {
  it('未認証 (401)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await POST(postRequest({ email: inviteeEmail }));

    expect(res.status).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('組織の一般メンバー (403)', async () => {
    profile = { organization_id: orgId, org_role: 'member', nickname: null };

    const res = await POST(postRequest({ email: inviteeEmail }));

    expect(res.status).toBe(403);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('JSON として読めない本文 (400)', async () => {
    const res = await POST(postRequest('this is not json'));

    expect(res.status).toBe(400);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});

describe('POST /api/org/members: 入力の検証 (#1163)', () => {
  it.each([
    ['未指定', { nickname: 'no email' }],
    ['空文字', { email: '' }],
    ['形式が不正', { email: 'not-an-email' }],
    ['文字列以外', { email: ['a@example.com'] }],
    ['254 文字を超える', { email: `${'a'.repeat(250)}@example.com` }],
  ])('メールアドレスが不正 (%s): 400 INVALID_BODY を返し、招待も limiter も呼ばない', async (_label, body) => {
    const res = await POST(postRequest(body));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('INVALID_BODY');
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('前後に空白がある宛先は空白を除き、小文字にそろえる', async () => {
    const res = await POST(postRequest({ email: '  Hanako@Example.COM ' }));

    expect(res.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledWith(
      'create_org_invite',
      expect.objectContaining({ p_email: inviteeEmail }),
    );
    expect(mockCheckRateLimit.mock.calls[2]).toEqual([`org-invite:${orgId}:${inviteeHash}`, 'invite-target']);
  });

  it('nickname は招待メールの宛名になる (前後の空白は除く)', async () => {
    const res = await POST(postRequest({ email: inviteeEmail, nickname: '  花子  ' }));

    expect(res.status).toBe(201);
    expect(mockSendEmail.mock.calls[0][0].text.startsWith('花子 様')).toBe(true);
  });

  it.each([[''], ['   ']])('nickname が空 (%j) なら宛名なし (メールアドレス宛て) として扱う', async (nickname) => {
    const res = await POST(postRequest({ email: inviteeEmail, nickname }));

    expect(res.status).toBe(201);
    expect(mockSendEmail.mock.calls[0][0].text.startsWith(`${inviteeEmail} 様`)).toBe(true);
  });

  it('nickname が null でも宛名なしとして扱う (以前と同じ)', async () => {
    const res = await POST(postRequest({ email: inviteeEmail, nickname: null }));

    expect(res.status).toBe(201);
  });

  it('nickname は 50 文字まで。51 文字は 400', async () => {
    const ok = await POST(postRequest({ email: inviteeEmail, nickname: 'あ'.repeat(50) }));
    expect(ok.status).toBe(201);

    mockRpc.mockClear();
    const tooLong = await POST(postRequest({ email: inviteeEmail, nickname: 'あ'.repeat(51) }));
    const json = await tooLong.json();
    expect(tooLong.status).toBe(400);
    expect(json.error.code).toBe('INVALID_BODY');
    expect(json.error.message).toBe('ニックネームは 50 文字以内の文字列で入力してください');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('未知のキー (古いモバイルアプリが送る password など) は無視する。RPC にもメールにも渡さない', async () => {
    const res = await POST(
      postRequest({ email: inviteeEmail, password: 'legacy-admin-chosen-pass', role: 'owner', organization_id: 'x' }),
    );

    expect(res.status).toBe(201);
    expect(JSON.stringify(mockRpc.mock.calls)).not.toContain('legacy-admin-chosen-pass');
    expect(JSON.stringify(mockSendEmail.mock.calls)).not.toContain('legacy-admin-chosen-pass');
    // role はリクエストで決められない (常に member)
    expect(mockRpc).toHaveBeenCalledWith('create_org_invite', expect.objectContaining({ p_role: 'member' }));
  });
});

describe('POST /api/org/members: DB の 24 時間上限 (#1163)', () => {
  // enforce_membership_daily_cap が RAISE する RATE_LIMITED を、PostgREST が RPC のエラーとして返した形
  const dbRateLimited = (overrides: Record<string, unknown> = {}) => ({
    data: null,
    error: {
      message: 'RATE_LIMITED',
      code: 'P0001',
      details: 'org_invite:per_org',
      hint: 'retry_after_sec=3000',
      ...overrides,
    },
  });

  it('RPC が RATE_LIMITED: アプリ層の上限と同じ 429 / 入れ子の RATE_LIMITED / Retry-After (HINT の秒数) を返し、メールは送らない', async () => {
    mockRpc.mockImplementation(async () => dbRateLimited());

    const res = await POST(postRequest({ email: inviteeEmail }));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: '本日の送信上限に達しました。しばらく時間をおいてからお試しください。',
        retryAfter: 3000,
      },
    });
    expect(res.headers.get('Retry-After')).toBe('3000');
    expect(mockSendEmail).not.toHaveBeenCalled();
    // 招待の詳細取得 (get_invite_details) にも進まない
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('HINT が読めないときも 429 にする (Retry-After は 1 時間)', async () => {
    mockRpc.mockImplementation(async () => dbRateLimited({ hint: null }));

    const res = await POST(postRequest({ email: inviteeEmail }));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.retryAfter).toBe(3600);
    expect(res.headers.get('Retry-After')).toBe('3600');
  });

  it('withUser(招待者 ID).warn に flow=org-invite / layer=db / 上限名を記録する (メールアドレスは残さない)', async () => {
    mockRpc.mockImplementation(async () => dbRateLimited());

    await POST(postRequest({ email: inviteeEmail }));

    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn.mock.calls[0][1]).toMatchObject({
      flow: 'org-invite',
      layer: 'db',
      rule: 'org_invite:per_org',
      retry_after_sec: 3000,
    });
    expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain('@');
  });
});

describe('POST /api/org/members: 既存の挙動 (退行確認)', () => {
  it('RPC が SEAT_LIMIT_EXCEEDED: 409 を返し、Retry-After は付けない', async () => {
    mockRpc.mockImplementation(async () => ({ data: null, error: { message: 'SEAT_LIMIT_EXCEEDED' } }));

    const res = await POST(postRequest({ email: inviteeEmail }));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('SEAT_LIMIT_EXCEEDED');
    // #1172: 本文の文は RPC の生のエラー文ではなく、コードごとの固定の文
    expect(json.error.message).toBe('組織のライセンス数の上限に達しているため、招待できません');
    expect(res.headers.get('Retry-After')).toBeNull();
  });
});

describe('POST /api/org/members: RPC の生のエラー文を本文に出さない (#1172)', () => {
  const SENTINEL = 'permission denied for table organization_invites (sentinel-org-members-route-1172)';

  it('コードに当たらない RPC のエラー: 汎用の 500 (nested) を返し、元のエラーは構造化ログにだけ残す', async () => {
    mockRpc.mockImplementation(async () => ({ data: null, error: { message: SENTINEL, code: '42501' } }));

    const res = await POST(postRequest({ email: inviteeEmail }));
    const raw = await res.text();

    expect(res.status).toBe(500);
    expect(raw).not.toContain(SENTINEL);
    expect(JSON.parse(raw)).toEqual({ error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました' } });
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect((mockLogError.mock.calls[0] as unknown[])[1]).toMatchObject({ message: SENTINEL });
  });

  it('コードに当たる RPC のエラー (4xx) でも、エラー文のコード以外の部分は本文に出さない', async () => {
    mockRpc.mockImplementation(async () => ({ data: null, error: { message: `NOT_ORG_ADMIN ${SENTINEL}`, code: 'P0001' } }));

    const res = await POST(postRequest({ email: inviteeEmail }));
    const raw = await res.text();

    expect(res.status).toBe(403);
    expect(raw).not.toContain(SENTINEL);
    expect(JSON.parse(raw)).toEqual({
      error: { code: 'NOT_ORG_ADMIN', message: '招待できるのは組織のオーナーと管理者だけです' },
    });
  });
});

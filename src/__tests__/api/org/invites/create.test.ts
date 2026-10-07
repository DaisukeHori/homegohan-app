import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RateLimitCategory, RateLimitResult } from '@/lib/rate-limit';

// POST /api/org/invites の招待メール送信回数制限と入力検証 (#1163)

// Supabase クライアントのモック。org 系の route は createClient() を同期で呼ぶので mockResolvedValue ではなく vi.fn(() => client)
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

const { POST } = await import('@/app/api/org/invites/route');

const user = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', email: 'owner@example.com' };
const orgId = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const foreignOrgId = 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a99';
const inviteeEmail = 'taro@example.com';
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

let profile: { organization_id: string | null; org_role: string | null; nickname: string | null };

const postRequest = (body: unknown) =>
  new Request('http://localhost/api/org/invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user }, error: null });
  limiter({});

  profile = { organization_id: orgId, org_role: 'owner', nickname: '山田' };
  mockFrom.mockImplementation((table: string) => {
    if (table === 'user_profiles') return chain({ data: profile, error: null });
    if (table === 'organizations') return chain({ data: { name: 'テスト株式会社' }, error: null });
    throw new Error(`unexpected table: ${table}`);
  });

  mockRpc.mockReset();
  mockRpc.mockImplementation(async (fn: string) => {
    if (fn === 'create_org_invite') return { data: inviteRow, error: null };
    if (fn === 'get_invite_details') return { data: { is_existing_user: false }, error: null };
    throw new Error(`unexpected rpc: ${fn}`);
  });

  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ id: 'email-1' });
});

describe('POST /api/org/invites: 送信回数の制限 (#1163)', () => {
  it('上限内: 200 を返し、招待メールを 1 通だけ送る', async () => {
    const res = await POST(postRequest({ email: inviteeEmail, role: 'member' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.invite.id).toBe(inviteRow.id);
    expect(mockRpc).toHaveBeenCalledWith('create_org_invite', {
      p_organization_id: orgId,
      p_email: inviteeEmail,
      p_role: 'member',
      p_custom_message: undefined,
    });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe(inviteeEmail);
  });

  it('招待者 → 組織 (プロフィールの organization_id) → 宛先ハッシュの順に判定する', async () => {
    await POST(postRequest({ email: inviteeEmail }));

    expect(mockCheckRateLimit.mock.calls).toEqual([
      [user.id, 'org-invite'],
      [orgId, 'org-invite-scope'],
      [`org-invite:${orgId}:${inviteeHash}`, 'invite-target'],
    ]);
    for (const [key] of mockCheckRateLimit.mock.calls) {
      expect(key).not.toContain('@');
    }
  });

  it('リクエストの organization_id は鍵にも RPC にも使わない (プロフィールの組織だけ)', async () => {
    const res = await POST(postRequest({ email: inviteeEmail, organization_id: foreignOrgId }));

    expect(res.status).toBe(200);
    expect(JSON.stringify(mockCheckRateLimit.mock.calls)).not.toContain(foreignOrgId);
    expect(mockRpc).toHaveBeenCalledWith(
      'create_org_invite',
      expect.objectContaining({ p_organization_id: orgId }),
    );
    expect(JSON.stringify(mockRpc.mock.calls)).not.toContain(foreignOrgId);
  });

  it('招待者の分あたり上限を超過: 429 / 入れ子の RATE_LIMITED / Retry-After。RPC もメール送信も呼ばない', async () => {
    limiter({ 'org-invite': deny(60, 30) });

    const res = await POST(postRequest({ email: inviteeEmail }));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.code).toBe('RATE_LIMITED');
    expect(json.error.message).toBe('短時間に操作が集中しています。1分ほど待ってからお試しください。');
    expect(json.error.retryAfter).toBeGreaterThanOrEqual(20);
    expect(res.headers.get('Retry-After')).toBe(String(json.error.retryAfter));
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
  });

  it('組織全体の日次上限を超過: 招待者の枠が残っていても 429 (宛先の枠は数えない)', async () => {
    limiter({ 'org-invite-scope': deny(24 * 60 * 60, 7200) });

    const res = await POST(postRequest({ email: inviteeEmail }));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.code).toBe('RATE_LIMITED');
    expect(json.error.message).toBe('本日の送信上限に達しました。しばらく時間をおいてからお試しください。');
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(7000);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockCheckRateLimit.mock.calls.map((c) => c[1])).toEqual(['org-invite', 'org-invite-scope']);
  });

  it('宛先の上限だけを超過: 429。RPC もメール送信も呼ばない', async () => {
    limiter({ 'invite-target': deny(24 * 60 * 60, 3600) });

    const res = await POST(postRequest({ email: inviteeEmail }));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.code).toBe('RATE_LIMITED');
    expect(res.headers.get('Retry-After')).toBe(String(json.error.retryAfter));
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(3);
  });

  it('limiter のバックエンドが例外を投げたら伝播し (fail-closed)、RPC もメール送信も実行されない', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('ECONNREFUSED: upstash unreachable'));

    await expect(POST(postRequest({ email: inviteeEmail }))).rejects.toThrow('ECONNREFUSED');

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalled();
  });
});

describe('POST /api/org/invites: 認証・権限・入力の検証が先 (limiter を使わない)', () => {
  it('未認証 (401)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });

    const res = await POST(postRequest({ email: inviteeEmail }));

    expect(res.status).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('組織の一般メンバー (403)', async () => {
    profile = { organization_id: orgId, org_role: 'member', nickname: null };

    const res = await POST(postRequest({ email: inviteeEmail }));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('INSUFFICIENT_PERMISSION');
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('組織に所属していない (403)', async () => {
    profile = { organization_id: null, org_role: 'owner', nickname: null };

    const res = await POST(postRequest({ email: inviteeEmail }));

    expect(res.status).toBe(403);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('JSON として読めない本文 (400 INVALID_BODY)', async () => {
    const res = await POST(postRequest('this is not json'));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('INVALID_BODY');
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});

describe('POST /api/org/invites: 入力の検証 (#1163)', () => {
  it.each([
    ['形式が不正', { email: 'not-an-email' }],
    ['空文字', { email: '' }],
    ['未指定', {}],
    ['文字列以外 (数値)', { email: 12345 }],
    ['@ が 2 つ', { email: 'a@b@example.com' }],
    ['254 文字を超える', { email: `${'a'.repeat(250)}@example.com` }],
  ])('メールアドレスが不正 (%s): 400 INVALID_BODY を返し、招待も limiter も呼ばない', async (_label, body) => {
    const res = await POST(postRequest(body));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('INVALID_BODY');
    expect(json.error.message).toBe('メールアドレスを正しい形式で入力してください');
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('前後に空白がある宛先は空白を除いて扱う', async () => {
    const res = await POST(postRequest({ email: `  ${inviteeEmail}\n` }));

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith(
      'create_org_invite',
      expect.objectContaining({ p_email: inviteeEmail }),
    );
    expect(mockCheckRateLimit.mock.calls[2]).toEqual([`org-invite:${orgId}:${inviteeHash}`, 'invite-target']);
  });

  it('大文字を含む宛先は小文字にそろえる', async () => {
    const res = await POST(postRequest({ email: 'Taro@EXAMPLE.com' }));

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith(
      'create_org_invite',
      expect.objectContaining({ p_email: inviteeEmail }),
    );
    expect(mockSendEmail.mock.calls[0][0].to).toBe(inviteeEmail);
  });

  it('role を省略すると member、admin は指定できる', async () => {
    await POST(postRequest({ email: inviteeEmail }));
    await POST(postRequest({ email: inviteeEmail, role: 'admin' }));

    const roles = mockRpc.mock.calls.filter((c) => c[0] === 'create_org_invite').map((c) => c[1].p_role);
    expect(roles).toEqual(['member', 'admin']);
  });

  it.each([['owner'], ['superuser'], [''], [null]])(
    'role に %j は指定できない (400 INVALID_BODY)。招待は作らない',
    async (role) => {
      const res = await POST(postRequest({ email: inviteeEmail, role }));
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error.code).toBe('INVALID_BODY');
      expect(json.error.message).toBe('role は admin または member のみ指定できます');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
    },
  );

  it('custom_message は 500 文字まで。501 文字は 400', async () => {
    const ok = await POST(postRequest({ email: inviteeEmail, custom_message: 'あ'.repeat(500) }));
    expect(ok.status).toBe(200);

    mockRpc.mockClear();
    const tooLong = await POST(postRequest({ email: inviteeEmail, custom_message: 'あ'.repeat(501) }));
    const json = await tooLong.json();
    expect(tooLong.status).toBe(400);
    expect(json.error.code).toBe('INVALID_BODY');
    expect(json.error.message).toBe('メッセージは 500 文字以内の文字列で入力してください');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('custom_message が null / 空なら「メッセージなし」として扱う (以前と同じ)', async () => {
    const nullRes = await POST(postRequest({ email: inviteeEmail, custom_message: null }));
    expect(nullRes.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith(
      'create_org_invite',
      expect.objectContaining({ p_custom_message: undefined }),
    );
  });

  it('未知のキー (password など) は無視する。RPC にもメールにも渡さない', async () => {
    const res = await POST(
      postRequest({ email: inviteeEmail, password: 'super-secret-pass', is_admin: true }),
    );

    expect(res.status).toBe(200);
    expect(JSON.stringify(mockRpc.mock.calls)).not.toContain('super-secret-pass');
    expect(JSON.stringify(mockSendEmail.mock.calls)).not.toContain('super-secret-pass');
  });

  it('本文が配列・null など、オブジェクトでない場合は 400', async () => {
    for (const body of ['null', '[]', '"text"', '123']) {
      const res = await POST(postRequest(body));
      expect(res.status).toBe(400);
    }
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});

describe('POST /api/org/invites: 既存の挙動 (退行確認)', () => {
  it('RPC が NOT_ORG_ADMIN: 403 を返し、Retry-After は付けない', async () => {
    mockRpc.mockImplementation(async () => ({ data: null, error: { message: 'NOT_ORG_ADMIN' } }));

    const res = await POST(postRequest({ email: inviteeEmail }));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('NOT_ORG_ADMIN');
    expect(json.error).not.toHaveProperty('retryAfter');
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

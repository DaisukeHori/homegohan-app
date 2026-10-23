import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmailSendError } from '@/lib/emails/send-result';
import type { RateLimitCategory, RateLimitResult } from '@/lib/rate-limit';
import { DEFAULT_SITE_URL } from '@/lib/site-config';

// POST /api/org/owner-transfer/propose の譲渡提案メール送信回数制限 (#1163)

const mockGetUser = vi.fn();
const mockRpc = vi.fn();
const mockFrom = vi.fn();
const client = { auth: { getUser: mockGetUser }, rpc: mockRpc, from: mockFrom };

// 宛先のメールアドレスを引く管理者クライアントは本物の getSupabaseAdmin を通す
// (#1162。接続情報は env-required の getter で取り出し、下で差し替えた @supabase/supabase-js の createClient で作る)
vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>();
  return {
    createClient: vi.fn(() => client),
    getSupabaseAdmin: vi.fn(actual.getSupabaseAdmin),
  };
});

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
const { getSupabaseAdmin } = await import('@/lib/supabase/server');
const { createClient: createSupabaseJsClient } = await import('@supabase/supabase-js');

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

describe('POST /api/org/owner-transfer/propose: DB の 24 時間上限 (#1163)', () => {
  // enforce_membership_daily_cap が RAISE する RATE_LIMITED を、PostgREST が RPC のエラーとして返した形
  const dbRateLimited = (overrides: Record<string, unknown> = {}) => ({
    data: null,
    error: {
      message: 'RATE_LIMITED',
      code: 'P0001',
      details: 'transfer_propose:per_actor',
      hint: 'retry_after_sec=1800',
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
        retryAfter: 1800,
      },
    });
    expect(res.headers.get('Retry-After')).toBe('1800');
  });

  it('RPC の生の文字列 (RATE_LIMITED) を message にせず、提案メールも送らない', async () => {
    mockRpc.mockResolvedValue(dbRateLimited());

    const json = await (await POST(postRequest(validBody))).json();

    expect(json.error.message).not.toBe('RATE_LIMITED');
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it('HINT が読めないときも 429 にする (Retry-After は 1 時間)', async () => {
    mockRpc.mockResolvedValue(dbRateLimited({ hint: 'retry later' }));

    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.retryAfter).toBe(3600);
    expect(res.headers.get('Retry-After')).toBe('3600');
  });

  it('withUser(user.id).warn に flow=transfer-propose / layer=db / 上限名を記録する', async () => {
    mockRpc.mockResolvedValue(dbRateLimited());

    await POST(postRequest(validBody));

    expect(mockWithUser).toHaveBeenCalledWith(owner.id);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn.mock.calls[0][1]).toMatchObject({
      flow: 'transfer-propose',
      layer: 'db',
      rule: 'transfer_propose:per_actor',
      retry_after_sec: 1800,
    });
  });
});

describe('POST /api/org/owner-transfer/propose: 既存の挙動 (退行確認)', () => {
  it('owner でないユーザー (403): RPC もメール送信も呼ばない', async () => {
    profile = { organization_id: orgId, org_role: 'admin', nickname: null };

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(403);
    // 本文の文は日本語の役割名 (以前の 'owner のみ譲渡提案が可能です' の英字の役割名は出さない。#1917)。code は従来のまま
    expect(await res.json()).toEqual({
      error: { code: 'INSUFFICIENT_PERMISSION', message: 'オーナーだけが譲渡を提案できます' },
    });
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

describe('POST /api/org/owner-transfer/propose: 名前に仮置きの Guest を使わない (#1649)', () => {
  /** 提案者の行 (organization_id, org_role, nickname) と、提案先の行 (nickname だけ) を別の値にする */
  function nicknames(fromNickname: string, toNickname: string) {
    profile = { organization_id: orgId, org_role: 'owner', nickname: fromNickname };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') {
        const c: Record<string, unknown> = {};
        let columns = '';
        c.select = vi.fn((cols: string) => {
          columns = cols;
          return c;
        });
        c.eq = vi.fn(() => c);
        c.single = vi.fn(async () =>
          columns.trim() === 'nickname'
            ? { data: { nickname: toNickname }, error: null }
            : { data: profile, error: null },
        );
        return c;
      }
      if (table === 'organizations') return chain({ data: { name: 'テスト株式会社' }, error: null });
      throw new Error(`unexpected table: ${table}`);
    });
  }

  it.each(['Guest', ' Guest ', '   '])(
    '両者の nickname が %j なら、差出人はメールアドレスの @ の前・宛名は提案先のメールアドレス',
    async (nickname) => {
      nicknames(nickname, nickname);

      const res = await POST(postRequest(validBody));

      expect(res.status).toBe(200);
      const text: string = mockSendEmail.mock.calls[0][0].text;
      expect(text.startsWith('next-owner@example.com 様')).toBe(true);
      expect(text).toContain('owner 様から、「テスト株式会社」のオーナー権限の譲渡提案');
      expect(text).not.toContain('Guest');
    },
  );

  it.each([
    ['guest', 'guest'],
    [' 山田 ', '山田'],
  ])('両者の nickname が %j (本人が付けた名前) なら、差出人と宛名にその名前を使う', async (nickname, expected) => {
    nicknames(nickname, nickname);

    await POST(postRequest(validBody));

    const text: string = mockSendEmail.mock.calls[0][0].text;
    expect(text.startsWith(`${expected} 様`)).toBe(true);
    expect(text).toContain(`${expected} 様から、「テスト株式会社」`);
  });
});

describe('POST /api/org/owner-transfer/propose: 承諾リンクの基点 (#1194)', () => {
  // リンクの基点は src/lib/membership/urls.ts (= サイトの URL。NEXT_PUBLIC_APP_URL) に 1 つだけある。
  // 以前は未設定のとき http://localhost:3000 になり、本番のメールに localhost のリンクが載りえた。
  // 手元の環境変数に左右されないよう、2 つとも明示する。
  it('NEXT_PUBLIC_APP_URL があれば、それを基点にした承諾リンクをメールに載せる', async () => {
    vi.stubEnv('NEXT_PUBLIC_INVITE_BASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test');

    await POST(postRequest(validBody));

    expect(mockSendEmail.mock.calls[0][0].text.split('\n')).toContain(
      `https://app.example.test/org/transfer-accept/${proposalId}`,
    );
  });

  it('どちらも未設定なら、localhost ではなくサイトの URL の既定値 (DEFAULT_SITE_URL) を基点にする', async () => {
    vi.stubEnv('NEXT_PUBLIC_INVITE_BASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');

    await POST(postRequest(validBody));

    const text: string = mockSendEmail.mock.calls[0][0].text;
    expect(text.split('\n')).toContain(`${DEFAULT_SITE_URL}/org/transfer-accept/${proposalId}`);
    expect(text).not.toContain('localhost');
  });
});

describe('POST /api/org/owner-transfer/propose: メール送信の失敗 (#1193)', () => {
  it('メール送信が ok: false の結果で返っても (sendEmail は配信の失敗で例外を投げない) 提案は作成済みなので 200 を返し、警告に残す', async () => {
    const sendError = new EmailSendError('application_error', 'EMAIL_SEND_FAILED: Service Unavailable', 503, 4, true);
    mockSendEmail.mockResolvedValue({ ok: false, id: null, attempts: 4, skipped: false, error: sendError });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.proposal_id).toBe(proposalId);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('メール送信失敗'), sendError);
    warn.mockRestore();
  });

  it('RESEND_API_KEY が無くて送らなかった (skipped) ときは、警告を残さず 200 を返す', async () => {
    const skippedError = new EmailSendError('not_configured', 'EMAIL_NOT_CONFIGURED: RESEND_API_KEY が未設定', null, 0, false);
    mockSendEmail.mockResolvedValue({ ok: false, id: null, attempts: 0, skipped: true, error: skippedError });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('POST /api/org/owner-transfer/propose: 管理者クライアントは canonical の getSupabaseAdmin で作る (#1162)', () => {
  it('同じ鍵・同じ設定 (セッションを保存しない・自動で更新しない) のクライアントを 1 回だけ作り、宛先のメールアドレスを引く', async () => {
    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(200);
    expect(vi.mocked(getSupabaseAdmin)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createSupabaseJsClient)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createSupabaseJsClient)).toHaveBeenCalledWith('http://127.0.0.1:54321', 'service-role-test-key', {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    expect(mockGetUserById).toHaveBeenCalledWith(toUserId);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('owner でない (403) なら、管理者クライアントを作らない (認可を先に通す)', async () => {
    profile = { organization_id: orgId, org_role: 'admin', nickname: null };

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(403);
    expect(vi.mocked(getSupabaseAdmin)).not.toHaveBeenCalled();
    expect(vi.mocked(createSupabaseJsClient)).not.toHaveBeenCalled();
  });

  it('service_role の接続情報が欠けていたら、提案は 200 のまま、メールだけを送らずに info に残す (警告にはしない)', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.proposal_id).toBe(proposalId);
    expect(vi.mocked(createSupabaseJsClient)).not.toHaveBeenCalled();
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('メール送信スキップ'), expect.objectContaining({ proposalId }));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('メール送信失敗'), expect.anything());
    info.mockRestore();
    warn.mockRestore();
  });

  it('管理者クライアントでの取得が失敗したら、提案は 200 のまま、警告に残し、スキップの info は出さない', async () => {
    const readError = new Error('getUserById failed');
    mockGetUserById.mockRejectedValue(readError);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('メール送信失敗'), readError);
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('メール送信スキップ'), expect.anything());
    info.mockRestore();
    warn.mockRestore();
  });
});

describe('POST /api/org/owner-transfer/propose: 大文字・混在の UUID (#1793)', () => {
  it('本人のオーナーの組織の organization_id を大文字で送っても 403 にならず 200 で、RPC・宛先の取得・組織名の取得には小文字の id を渡す', async () => {
    const res = await POST(postRequest({ organization_id: orgId.toUpperCase(), to_user_id: toUserId.toUpperCase() }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.proposal_id).toBe(proposalId);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('propose_org_owner_transfer', {
      p_organization_id: orgId,
      p_to_user_id: toUserId,
    });
    expect(mockGetUserById).toHaveBeenCalledWith(toUserId);
    const eqArgs = mockFrom.mock.results.flatMap((r) => (r.value as { eq: { mock: { calls: unknown[][] } } }).eq.mock.calls);
    expect(eqArgs).toContainEqual(['id', orgId]);
    expect(eqArgs).toContainEqual(['id', toUserId]);
    expect(eqArgs.flat()).not.toContain(orgId.toUpperCase());
    expect(eqArgs.flat()).not.toContain(toUserId.toUpperCase());
  });

  it('大文字・小文字の混在でも同じ (organization_id の英字を 1 文字おきに大文字にする)', async () => {
    const mixed = orgId.replace(/[a-f]/g, (c, i: number) => (i % 2 === 0 ? c.toUpperCase() : c));
    expect(mixed).not.toBe(orgId);
    expect(mixed).not.toBe(orgId.toUpperCase());

    const res = await POST(postRequest({ organization_id: mixed, to_user_id: toUserId }));

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('propose_org_owner_transfer', {
      p_organization_id: orgId,
      p_to_user_id: toUserId,
    });
  });

  it('他の組織の id は大文字にしても 403 のまま (そろえても自分の組織にはならない)', async () => {
    const otherOrgId = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
    const res = await POST(postRequest({ organization_id: otherOrgId.toUpperCase(), to_user_id: toUserId }));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('INSUFFICIENT_PERMISSION');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmailSendError } from '@/lib/emails/send-result';
import type { RateLimitCategory, RateLimitResult } from '@/lib/rate-limit';

// POST /api/org/owner-transfer/propose の譲渡提案メール送信回数制限 (#1163)

const mockGetUser = vi.fn();
const mockRpc = vi.fn();
const mockFrom = vi.fn();
const client = { auth: { getUser: mockGetUser }, rpc: mockRpc, from: mockFrom };

// 譲渡先のニックネームを読む service_role の client。提案者が対象組織の owner だと確認したあとでだけ作る
const mockAdminFrom = vi.fn();
const mockGetSupabaseAdmin = vi.fn(() => ({ from: mockAdminFrom }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => client),
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
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
const otherOrgId = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const outsiderId = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';

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

type Row = Record<string, unknown>;
type RecordedFilters = Array<Array<[string, unknown]>>;

/**
 * 行の配列に対して、.eq() の絞り込みを実際に適用する簡易クエリ (single / maybeSingle で 1 行を返す)。
 * 呼ばれた絞り込みを queries に記録する。RLS そのものは再現しないので、見える行を呼び出し側が決める。
 */
function rowsChain(rows: Row[], queries: RecordedFilters) {
  const filters: Array<[string, unknown]> = [];
  const matched = () => rows.filter((row) => filters.every(([column, value]) => row[column] === value));
  const notOne = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' };
  const c: Record<string, unknown> = {};
  c.select = vi.fn(() => c);
  c.eq = vi.fn((column: string, value: unknown) => {
    filters.push([column, value]);
    return c;
  });
  c.single = vi.fn(async () => {
    queries.push([...filters]);
    const found = matched();
    return found.length === 1 ? { data: found[0], error: null } : { data: null, error: notOne };
  });
  c.maybeSingle = vi.fn(async () => {
    queries.push([...filters]);
    const found = matched();
    if (found.length > 1) return { data: null, error: notOne };
    return { data: found[0] ?? null, error: null };
  });
  return c;
}

let profile: { organization_id: string | null; org_role: string | null; nickname: string | null };
/** 本人のセッションの client が user_profiles に出した絞り込み (RLS で本人の行しか読めない) */
let sessionProfileQueries: RecordedFilters;
/** service_role の client に見える user_profiles の行 */
let adminProfiles: Row[];
/** service_role の client が user_profiles に出した絞り込み */
let adminProfileQueries: RecordedFilters;

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
  // user_profiles の SELECT ポリシーは「本人の行だけ」(Users can view own profile)。本人のセッションには本人の行しか見えない
  sessionProfileQueries = [];
  mockFrom.mockImplementation((table: string) => {
    if (table === 'user_profiles') return rowsChain([{ id: owner.id, ...profile }], sessionProfileQueries);
    if (table === 'organizations') return chain({ data: { name: 'テスト株式会社' }, error: null });
    throw new Error(`unexpected table: ${table}`);
  });

  // service_role には全ての行が見える: 譲渡先 (対象組織のメンバー) と、別の組織のユーザー
  adminProfiles = [
    { id: toUserId, organization_id: orgId, nickname: '次期オーナー' },
    { id: outsiderId, organization_id: otherOrgId, nickname: '組織外の人' },
  ];
  adminProfileQueries = [];
  mockAdminFrom.mockReset();
  mockAdminFrom.mockImplementation((table: string) => {
    if (table === 'user_profiles') return rowsChain(adminProfiles, adminProfileQueries);
    throw new Error(`unexpected admin table: ${table}`);
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

describe('POST /api/org/owner-transfer/propose: 譲渡先のニックネーム (提案メールの宛名)', () => {
  const sentText = () => String(mockSendEmail.mock.calls[0][0].text);

  it('譲渡先のニックネームを service_role で読み、提案メールの宛名にする (メールアドレスにはならない)', async () => {
    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe('next-owner@example.com');
    expect(sentText()).toContain('次期オーナー 様');
    expect(sentText()).not.toContain('next-owner@example.com 様');
  });

  it('service_role で読むのは「譲渡先の id かつ対象組織の id」の 1 行だけ。nickname 以外の列は読まない', async () => {
    await POST(postRequest(validBody));

    expect(mockAdminFrom.mock.calls).toEqual([['user_profiles']]);
    expect(adminProfileQueries).toEqual([
      [
        ['id', toUserId],
        ['organization_id', orgId],
      ],
    ]);
    const adminQuery = mockAdminFrom.mock.results[0].value as { select: ReturnType<typeof vi.fn> };
    expect(adminQuery.select).toHaveBeenCalledWith('nickname');
  });

  it('本人のセッションで user_profiles を読むのは、提案者本人の行だけ (他人の行は service_role を使う)', async () => {
    await POST(postRequest(validBody));

    expect(sessionProfileQueries.length).toBeGreaterThan(0);
    for (const filters of sessionProfileQueries) {
      expect(filters).toEqual([['id', owner.id]]);
    }
    expect(JSON.stringify(sessionProfileQueries)).not.toContain(toUserId);
  });

  it('譲渡先が対象組織のメンバーでなければ、そのプロフィールは読まない (宛名はメールアドレス)。組織の外の人のニックネームは出ない', async () => {
    // RPC は成功したと仮定した防御の確認 (実際の RPC は TARGET_NOT_IN_ORG で断る)。絞り込みの organization_id だけで守られる
    const res = await POST(postRequest({ organization_id: orgId, to_user_id: outsiderId }));

    expect(res.status).toBe(200);
    expect(adminProfileQueries).toEqual([
      [
        ['id', outsiderId],
        ['organization_id', orgId],
      ],
    ]);
    expect(sentText()).toContain('next-owner@example.com 様');
    expect(sentText()).not.toContain('組織外の人');
  });

  it('ニックネームが空でも、宛名はメールアドレスにする', async () => {
    adminProfiles = [{ id: toUserId, organization_id: orgId, nickname: '' }];

    await POST(postRequest(validBody));

    expect(sentText()).toContain('next-owner@example.com 様');
  });

  it('ニックネームを読めなくても (DB の失敗)、提案は作成済みなので 200 を返し、宛名をメールアドレスにして送る。警告に残す', async () => {
    mockAdminFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: { code: '42501', message: 'permission denied for table user_profiles' } }),
          }),
        }),
      }),
    }));

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain('next-owner@example.com 様');
    expect(mockWithUser).toHaveBeenCalledWith(owner.id);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn.mock.calls[0][1]).toMatchObject({ organization_id: orgId, to_user_id: toUserId });
  });

  it('service_role の client を作れなくても (環境変数の不足など)、200 を返し、宛名をメールアドレスにして送る', async () => {
    mockGetSupabaseAdmin.mockImplementationOnce(() => {
      throw new Error('Supabase admin env is missing');
    });

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(200);
    expect(sentText()).toContain('next-owner@example.com 様');
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
  });

  it('SUPABASE_SERVICE_ROLE_KEY が無いときは、メールを送らないので service_role の client も作らない', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it('service_role の client は、提案を作ったあと (RPC の成功後) にだけ作る', async () => {
    await POST(postRequest(validBody));

    expect(mockGetSupabaseAdmin).toHaveBeenCalledTimes(1);
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockGetSupabaseAdmin.mock.invocationCallOrder[0]);
  });

  describe('認可・検証・RPC を通らなかったときは、service_role の client を作らず、プロフィールも読まない', () => {
    const expectUntouched = () => {
      expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
      expect(mockAdminFrom).not.toHaveBeenCalled();
      expect(adminProfileQueries).toEqual([]);
      expect(mockSendEmail).not.toHaveBeenCalled();
    };

    it('未認証 (401)', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });

      expect((await POST(postRequest(validBody))).status).toBe(401);
      expectUntouched();
    });

    it('送信回数の上限 (429)', async () => {
      limiter({ 'transfer-propose': deny(60) });

      expect((await POST(postRequest(validBody))).status).toBe(429);
      expectUntouched();
    });

    it('本文が不正 (400)', async () => {
      expect((await POST(postRequest({ organization_id: 'not-a-uuid' }))).status).toBe(400);
      expectUntouched();
    });

    it.each([
      ['owner ではない (admin)', { organization_id: orgId, org_role: 'admin', nickname: null }],
      ['owner だが、別の組織の owner', { organization_id: otherOrgId, org_role: 'owner', nickname: '山田' }],
      ['組織に所属していない', { organization_id: null, org_role: null, nickname: null }],
    ])('403: %s', async (_label, row) => {
      profile = row;

      expect((await POST(postRequest(validBody))).status).toBe(403);
      expectUntouched();
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('RPC の失敗 (提案を作れなかった)', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { message: 'TARGET_NOT_IN_ORG' } });

      expect((await POST(postRequest(validBody))).status).toBe(404);
      expectUntouched();
    });
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

import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailSendError } from '@/lib/emails/send-result';
import type { RateLimitCategory, RateLimitResult } from '@/lib/rate-limit';
import { TEST_TIME_ZONES, withTimeZoneAsync } from '../../../../../tests/helpers/time-zones';

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

// ルート自身の logger.error (プロフィール取得の失敗など)
const mockRouteLogError = vi.fn();

vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockRouteLogError,
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
      return chain({ data: { family_id: familyId, nickname: '花子' }, error: null });
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
      if (table === 'user_profiles') return chain({ data: { family_id: null, nickname: '花子' }, error: null });
      throw new Error(`unexpected table: ${table}`);
    });

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(403);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});

describe('POST /api/family/invites: 招待者のプロフィールの読み取り', () => {
  /** user_profiles 用の chain を返し、select に渡された列を後で確かめられるようにする */
  function profileChain(result: unknown) {
    const c = chain(result);
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') return c;
      if (table === 'family_groups') return chain({ data: { name: '山田家' }, error: null });
      throw new Error(`unexpected table: ${table}`);
    });
    return c;
  }

  it('user_profiles に無い列 (display_name) を select しない', async () => {
    const c = profileChain({ data: { family_id: familyId, nickname: '花子' }, error: null });

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(201);
    const selected = String((c.select as ReturnType<typeof vi.fn>).mock.calls[0][0])
      .split(',')
      .map((col) => col.trim());
    expect(selected).toEqual(expect.arrayContaining(['family_id', 'nickname']));
    expect(selected).not.toContain('display_name');
  });

  it('プロフィールの取得が DB エラー (例: 42703) なら 500 RPC_FAILED。記録し、limiter も RPC もメールも呼ばない', async () => {
    profileChain({ data: null, error: { code: '42703', message: 'column user_profiles.x does not exist' } });

    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('RPC_FAILED');
    expect(mockRouteLogError).toHaveBeenCalledTimes(1);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('プロフィールの行が無い (PGRST116) なら、従来どおり 403 NOT_FAMILY_ADULT', async () => {
    profileChain({ data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } });

    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('NOT_FAMILY_ADULT');
    expect(mockRouteLogError).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('nickname が空文字なら、招待メールの招待者名にログイン中のメールアドレスを使う', async () => {
    profileChain({ data: { family_id: familyId, nickname: '' }, error: null });

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(201);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockSendEmail.mock.calls[0][0])).toContain(user.email);
  });
});

// enforce_membership_daily_cap が RAISE する RATE_LIMITED を、PostgREST が RPC のエラーとして返した形
const dbRateLimitedError = (overrides: Record<string, unknown> = {}) => ({
  data: null,
  error: {
    message: 'RATE_LIMITED',
    code: 'P0001',
    details: 'family_invite:per_actor',
    hint: 'retry_after_sec=4321',
    ...overrides,
  },
});

describe('POST /api/family/invites: DB の 24 時間上限 (#1163)', () => {
  const DAILY_MESSAGE = '本日の送信上限に達しました。しばらく時間をおいてからお試しください。';

  it('RPC が RATE_LIMITED: アプリ層の上限と同じ 429 / 入れ子の RATE_LIMITED / Retry-After (HINT の秒数) を返す', async () => {
    mockRpc.mockImplementation(async () => dbRateLimitedError());

    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json).toEqual({ error: { code: 'RATE_LIMITED', message: DAILY_MESSAGE, retryAfter: 4321 } });
    expect(res.headers.get('Retry-After')).toBe('4321');
  });

  it('招待メールを送らず、招待の詳細も取りにいかず、500 の RPC_FAILED のログも出さない', async () => {
    mockRpc.mockImplementation(async () => dbRateLimitedError());
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await POST(postRequest(validBody));

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc.mock.calls[0][0]).toBe('create_family_invite');
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('HINT が読めないときも 429 にする (Retry-After は 1 時間)', async () => {
    mockRpc.mockImplementation(async () => dbRateLimitedError({ hint: null }));

    const res = await POST(postRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.retryAfter).toBe(3600);
    expect(res.headers.get('Retry-After')).toBe('3600');
  });

  it('withUser(user.id).warn に上限名と秒数を記録する (メールアドレスは残さない)', async () => {
    mockRpc.mockImplementation(async () => dbRateLimitedError());

    await POST(postRequest(validBody));

    expect(mockWithUser).toHaveBeenCalledWith(user.id);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn.mock.calls[0][1]).toMatchObject({
      flow: 'family-invite',
      layer: 'db',
      rule: 'family_invite:per_actor',
      retry_after_sec: 4321,
    });
    expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain('taro');
    expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain('@');
  });

  it('本文に RPC の生の文字列 (RATE_LIMITED 以外の内部情報) を出さない', async () => {
    mockRpc.mockImplementation(async () =>
      dbRateLimitedError({ message: 'RATE_LIMITED', details: 'family_invite:per_target' }),
    );

    const json = await (await POST(postRequest(validBody))).json();

    expect(JSON.stringify(json)).not.toContain('per_target');
    expect(JSON.stringify(json)).not.toContain('P0001');
    expect(JSON.stringify(json)).not.toContain(inviteeEmail);
  });

  it('RATE_LIMITED 以外の RPC エラーは従来どおり (MEMBER_LIMIT_EXCEEDED は 409、未知のエラーは 500 RPC_FAILED)', async () => {
    mockRpc.mockImplementation(async () => ({ data: null, error: { message: 'MEMBER_LIMIT_EXCEEDED', code: 'P0001' } }));
    const full = await POST(postRequest(validBody));
    expect(full.status).toBe(409);
    expect((await full.json()).error.code).toBe('MEMBER_LIMIT_EXCEEDED');
    expect(full.headers.get('Retry-After')).toBeNull();

    mockRpc.mockImplementation(async () => ({ data: null, error: { message: 'connection refused', code: '08006' } }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = await POST(postRequest(validBody));
    expect(broken.status).toBe(500);
    expect((await broken.json()).error.code).toBe('RPC_FAILED');
    expect(broken.headers.get('Retry-After')).toBeNull();
    consoleError.mockRestore();
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

  it('メール送信が ok: false の結果で返っても (sendEmail は配信の失敗で例外を投げない) 201 を返し (招待は残る)、警告に残す (#1193)', async () => {
    const sendError = new EmailSendError('rate_limit_exceeded', 'EMAIL_SEND_FAILED: Too many requests', 429, 4, true);
    mockSendEmail.mockResolvedValue({ ok: false, id: null, attempts: 4, skipped: false, error: sendError });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(201);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('email send failed'), sendError);
    warn.mockRestore();
  });

  it('RESEND_API_KEY が無くて送らなかった (skipped) ときは、警告を残さず 201 を返す (#1193)', async () => {
    const skippedError = new EmailSendError('not_configured', 'EMAIL_NOT_CONFIGURED: RESEND_API_KEY が未設定', null, 0, false);
    mockSendEmail.mockResolvedValue({ ok: false, id: null, attempts: 0, skipped: true, error: skippedError });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(201);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// #1433: 招待メールの「このリンクは YYYY-MM-DD まで有効です」の日付は、期限の時刻 (expires_at。timestamptz) が属する JST の暦日。
// 以前は expires_at.slice(0, 10) (UTC の暦日) で、期限が JST 0:00〜8:59 のとき 1 日早い日付を書いていた
// (例: JST 10/10 05:00 に作った 7 日間の招待は JST 10/17 05:00 まで有効なのに、メールには 10/16 と書いた)。
describe('POST /api/family/invites: 招待メールの期限の日付は JST の暦日 (#1433)', () => {
  /** 送った招待メールの本文 (text) */
  const sentText = () => {
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    return String((mockSendEmail.mock.calls[0][0] as { text: string }).text);
  };

  const withExpiresAt = (expiresAt: string) => {
    mockRpc.mockImplementation(async (fn: string) => {
      if (fn === 'create_family_invite') return { data: { ...inviteRow, expires_at: expiresAt }, error: null };
      if (fn === 'get_invite_details') return { data: { is_existing_user: false, invitee_display_name: null }, error: null };
      throw new Error(`unexpected rpc: ${fn}`);
    });
  };

  it.each([
    // [期限の時刻 (PostgREST が返す timestamptz の形), メールに書く日付, 以前の slice(0, 10)]
    ['2026-10-16T15:00:00+00:00', '2026-10-17', '2026-10-16'], // JST 10/17 0:00 ちょうど
    ['2026-10-16T23:59:59+00:00', '2026-10-17', '2026-10-16'], // JST 10/17 8:59:59
    ['2026-10-17T14:59:59+00:00', '2026-10-17', '2026-10-17'], // JST 10/17 23:59:59
    ['2026-10-31T15:00:00+00:00', '2026-11-01', '2026-10-31'], // 月初 (JST 11/1 0:00)
    ['2026-12-31T15:00:00+00:00', '2027-01-01', '2026-12-31'], // 年始 (JST 1/1 0:00)
  ])('期限 %s → メールは「%s まで有効」(以前は %s)。実行環境のタイムゾーンによらない', async (expiresAt, expected, legacy) => {
    for (const tz of TEST_TIME_ZONES) {
      mockSendEmail.mockClear();
      withExpiresAt(expiresAt);
      const res = await withTimeZoneAsync(tz, () => POST(postRequest(validBody)));
      expect(res.status, tz).toBe(201);
      const text = sentText();
      expect(text, tz).toContain(`このリンクは ${expected} まで有効です。`);
      if (legacy !== expected) expect(text, tz).not.toContain(`このリンクは ${legacy} まで有効です。`);
    }
  });

  it('既存ユーザー向けのメールも同じ日付 (JST の暦日)', async () => {
    mockRpc.mockImplementation(async (fn: string) => {
      if (fn === 'create_family_invite') return { data: { ...inviteRow, expires_at: '2026-10-16T15:00:00+00:00' }, error: null };
      if (fn === 'get_invite_details') return { data: { is_existing_user: true, invitee_display_name: '太郎' }, error: null };
      throw new Error(`unexpected rpc: ${fn}`);
    });
    const res = await POST(postRequest(validBody));
    expect(res.status).toBe(201);
    expect(sentText()).toContain('このリンクは 2026-10-17 まで有効です。');
  });

  it('期限の時刻が読めない値なら、メールだけ送らず警告に残し、201 を返す (作った招待は残す)', async () => {
    withExpiresAt('not-a-time');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST(postRequest(validBody));
    expect(res.status).toBe(201);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('email send failed'), expect.any(RangeError));
    warn.mockRestore();
  });
});

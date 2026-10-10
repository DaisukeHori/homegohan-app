import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ZodType } from 'zod';
import {
  CreateOrgInviteRequestBodySchema,
  AddOrgMemberRequestBodySchema,
} from '@/schemas/membership/organization-invite';
import { TEST_TIME_ZONES, withTimeZoneAsync } from '../../../../tests/helpers/time-zones';

// #1163 createOrgInviteWithEmail (POST /api/org/invites と POST /api/org/members の共通処理) の単体テスト。
// 送信回数の判定 (invite-throttle) はモックし、「RPC・メール送信の前に判定すること」「超過時の戻り値」を確かめる。

const mockCheckInviteEmailLimits = vi.fn();

// 部分モック: 送信回数の判定 (checkInviteEmailLimits) だけ差し替え、DB の上限 (RATE_LIMITED) の変換は本物を使う
vi.mock('@/lib/membership/invite-throttle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/membership/invite-throttle')>()),
  checkInviteEmailLimits: (...args: unknown[]) => mockCheckInviteEmailLimits(...args),
}));

// 構造化ログのモック (DB の上限の超過は createLogger(...).withUser(userId).warn(...) で記録される)
const mockLogWarn = vi.fn();
const mockWithUser = vi.fn(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: mockLogWarn,
  error: vi.fn(),
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

const {
  createOrgInviteWithEmail,
  orgInviteFailureResponse,
  invalidOrgInviteBodyResponse,
} = await import('@/lib/membership/org-invite');

const inviter = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', email: 'owner@example.com', nickname: '山田' };
const organizationId = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';

const inviteRow = {
  id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
  token: 'a'.repeat(64),
  email: 'taro@example.com',
  invited_role: 'member',
  status: 'pending',
  expires_at: '2026-10-21T02:00:00.000Z',
  custom_message: null,
  organization_id: organizationId,
};

const mockRpc = vi.fn();

function makeSupabase() {
  const orgChain: Record<string, unknown> = {};
  orgChain.select = vi.fn(() => orgChain);
  orgChain.eq = vi.fn(() => orgChain);
  orgChain.single = vi.fn(async () => ({ data: { name: 'テスト株式会社' }, error: null }));
  return {
    rpc: mockRpc,
    from: vi.fn(() => orgChain),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckInviteEmailLimits.mockReset();
  mockCheckInviteEmailLimits.mockResolvedValue(null);
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ id: 'email-1' });
  mockRpc.mockReset();
  mockRpc.mockImplementation(async (fn: string) => {
    if (fn === 'create_org_invite') return { data: inviteRow, error: null };
    if (fn === 'get_invite_details') return { data: { is_existing_user: false }, error: null };
    throw new Error(`unexpected rpc: ${fn}`);
  });
});

describe('createOrgInviteWithEmail: 送信回数の制限 (#1163)', () => {
  it('RPC とメール送信の前に、招待者 ID・組織 ID・正規化した宛先で判定する', async () => {
    const result = await createOrgInviteWithEmail({
      supabase: makeSupabase(),
      inviter,
      organizationId,
      email: '  Taro@Example.com ',
      role: 'member',
    });

    expect(result.ok).toBe(true);
    expect(mockCheckInviteEmailLimits).toHaveBeenCalledTimes(1);
    expect(mockCheckInviteEmailLimits).toHaveBeenCalledWith({
      flow: 'org-invite',
      userId: inviter.id,
      scopeId: organizationId,
      recipientEmail: 'taro@example.com',
    });
    // 判定 → RPC → メールの順
    const throttleOrder = mockCheckInviteEmailLimits.mock.invocationCallOrder[0];
    expect(throttleOrder).toBeLessThan(mockRpc.mock.invocationCallOrder[0]);
    expect(throttleOrder).toBeLessThan(mockSendEmail.mock.invocationCallOrder[0]);
  });

  it('上限超過: 429 / RATE_LIMITED / retryAfterSec を返し、RPC もメール送信も呼ばない', async () => {
    mockCheckInviteEmailLimits.mockResolvedValue({
      retryAfterSec: 42,
      windowSec: 60,
      message: '短時間に操作が集中しています。1分ほど待ってからお試しください。',
    });

    const result = await createOrgInviteWithEmail({
      supabase: makeSupabase(),
      inviter,
      organizationId,
      email: 'taro@example.com',
      role: 'member',
    });

    expect(result).toEqual({
      ok: false,
      status: 429,
      code: 'RATE_LIMITED',
      message: '短時間に操作が集中しています。1分ほど待ってからお試しください。',
      retryAfterSec: 42,
    });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('判定が例外を投げたら伝播し、RPC もメール送信も呼ばない (fail-closed)', async () => {
    const backendError = new Error('ECONNREFUSED: upstash unreachable');
    mockCheckInviteEmailLimits.mockRejectedValue(backendError);

    await expect(
      createOrgInviteWithEmail({
        supabase: makeSupabase(),
        inviter,
        organizationId,
        email: 'taro@example.com',
        role: 'member',
      }),
    ).rejects.toBe(backendError);

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe('createOrgInviteWithEmail: DB の 24 時間上限 (#1163)', () => {
  const DAILY_MESSAGE = '本日の送信上限に達しました。しばらく時間をおいてからお試しください。';
  // enforce_membership_daily_cap が RAISE する RATE_LIMITED を、PostgREST が RPC のエラーとして返した形
  const dbRateLimited = (overrides: Record<string, unknown> = {}) => ({
    data: null,
    error: {
      message: 'RATE_LIMITED',
      code: 'P0001',
      details: 'org_invite:per_org',
      hint: 'retry_after_sec=5400',
      ...overrides,
    },
  });
  const create = () =>
    createOrgInviteWithEmail({
      supabase: makeSupabase(),
      inviter,
      organizationId,
      email: 'taro@example.com',
      role: 'member',
    });

  it('RPC が RATE_LIMITED: アプリ層の上限と同じ 429 / RATE_LIMITED / 日次の文言 / retryAfterSec (HINT の秒数) を返す', async () => {
    mockRpc.mockImplementation(async () => dbRateLimited());

    const result = await create();

    expect(result).toEqual({
      ok: false,
      status: 429,
      code: 'RATE_LIMITED',
      message: DAILY_MESSAGE,
      retryAfterSec: 5400,
    });
  });

  it('RPC の生の文字列 (RATE_LIMITED) ではなく利用者向けの文言を返し、メールは送らない', async () => {
    mockRpc.mockImplementation(async () => dbRateLimited());

    const result = await create();

    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).not.toBe('RATE_LIMITED');
    expect(mockSendEmail).not.toHaveBeenCalled();
    // 招待の詳細取得 (get_invite_details) にも進まない
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('HINT が読めないときも 429 にする (retryAfterSec は 1 時間)', async () => {
    mockRpc.mockImplementation(async () => dbRateLimited({ hint: null }));

    const result = await create();

    expect(result).toMatchObject({ ok: false, status: 429, code: 'RATE_LIMITED', retryAfterSec: 3600 });
  });

  it('withUser(招待者 ID).warn に flow=org-invite / layer=db / 上限名を記録する (メールアドレスは残さない)', async () => {
    mockRpc.mockImplementation(async () => dbRateLimited({ details: 'org_invite:per_target' }));

    await create();

    expect(mockWithUser).toHaveBeenCalledWith(inviter.id);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn.mock.calls[0][1]).toMatchObject({
      flow: 'org-invite',
      layer: 'db',
      rule: 'org_invite:per_target',
      retry_after_sec: 5400,
    });
    expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain('taro');
  });

  it('失敗は orgInviteFailureResponse で Retry-After 付きの 429 になる (POST /api/org/invites と /api/org/members 共通)', async () => {
    mockRpc.mockImplementation(async () => dbRateLimited());

    const res = orgInviteFailureResponse((await create()) as never);
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('5400');
    expect(json).toEqual({ error: { code: 'RATE_LIMITED', message: DAILY_MESSAGE, retryAfter: 5400 } });
  });

  it('RATE_LIMITED 以外の RPC エラーは従来どおり (Retry-After なし。ログも出さない)', async () => {
    mockRpc.mockImplementation(async () => ({ data: null, error: { message: 'SEAT_LIMIT_EXCEEDED', code: 'P0001' } }));

    const result = await create();

    expect(result).toEqual({ ok: false, status: 409, code: 'SEAT_LIMIT_EXCEEDED', message: 'SEAT_LIMIT_EXCEEDED' });
    expect(mockLogWarn).not.toHaveBeenCalled();
  });
});

describe('createOrgInviteWithEmail: 既存の挙動', () => {
  it('RPC には小文字にした宛先を渡し、招待メールを 1 通だけ送る', async () => {
    const result = await createOrgInviteWithEmail({
      supabase: makeSupabase(),
      inviter,
      organizationId,
      email: 'Taro@Example.COM',
      role: 'admin',
      customMessage: 'よろしくお願いします',
    });

    expect(mockRpc).toHaveBeenCalledWith('create_org_invite', {
      p_organization_id: organizationId,
      p_email: 'taro@example.com',
      p_role: 'admin',
      p_custom_message: 'よろしくお願いします',
    });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe('taro@example.com');
    expect(result).toMatchObject({
      ok: true,
      invite: { id: inviteRow.id, status: 'pending', invite_url: expect.stringContaining(`/invite/${inviteRow.token}`) },
    });
  });

  it('RPC のエラーは対応する HTTP ステータスに変換する (retryAfterSec は付かない)', async () => {
    mockRpc.mockImplementation(async () => ({ data: null, error: { message: 'NOT_ORG_ADMIN' } }));

    const result = await createOrgInviteWithEmail({
      supabase: makeSupabase(),
      inviter,
      organizationId,
      email: 'taro@example.com',
      role: 'member',
    });

    expect(result).toEqual({ ok: false, status: 403, code: 'NOT_ORG_ADMIN', message: 'NOT_ORG_ADMIN' });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('メール送信が失敗しても招待は成功として返す', async () => {
    mockSendEmail.mockRejectedValue(new Error('smtp is down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await createOrgInviteWithEmail({
      supabase: makeSupabase(),
      inviter,
      organizationId,
      email: 'taro@example.com',
      role: 'member',
    });

    expect(result.ok).toBe(true);
    warn.mockRestore();
  });
});

describe('orgInviteFailureResponse', () => {
  it('429: Retry-After ヘッダーと error.retryAfter を付ける', async () => {
    const res = orgInviteFailureResponse({
      ok: false,
      status: 429,
      code: 'RATE_LIMITED',
      message: '本日の送信上限に達しました。しばらく時間をおいてからお試しください。',
      retryAfterSec: 3600,
    });
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
    expect(json).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: '本日の送信上限に達しました。しばらく時間をおいてからお試しください。',
        retryAfter: 3600,
      },
    });
  });

  it('429 以外: 従来どおり { error: { code, message } } だけで、Retry-After は付けない', async () => {
    const res = orgInviteFailureResponse({ ok: false, status: 403, code: 'NOT_ORG_ADMIN', message: 'NOT_ORG_ADMIN' });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(json).toEqual({ error: { code: 'NOT_ORG_ADMIN', message: 'NOT_ORG_ADMIN' } });
  });
});

describe('invalidOrgInviteBodyResponse', () => {
  const messageFor = async (schema: ZodType, body: unknown) => {
    const parsed = schema.safeParse(body);
    if (parsed.success) throw new Error('expected validation failure');
    const res = invalidOrgInviteBodyResponse(parsed.error);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('INVALID_BODY');
    return json.error.message as string;
  };

  it('項目ごとの文言を返す', async () => {
    expect(await messageFor(CreateOrgInviteRequestBodySchema, { email: 'not-an-email' })).toBe(
      'メールアドレスを正しい形式で入力してください',
    );
    expect(await messageFor(CreateOrgInviteRequestBodySchema, {})).toBe('メールアドレスを正しい形式で入力してください');
    expect(await messageFor(CreateOrgInviteRequestBodySchema, { email: 'a@example.com', role: 'owner' })).toBe(
      'role は admin または member のみ指定できます',
    );
    expect(
      await messageFor(CreateOrgInviteRequestBodySchema, { email: 'a@example.com', custom_message: 'x'.repeat(501) }),
    ).toBe('メッセージは 500 文字以内の文字列で入力してください');
    expect(
      await messageFor(AddOrgMemberRequestBodySchema, { email: 'a@example.com', nickname: 'x'.repeat(51) }),
    ).toBe('ニックネームは 50 文字以内の文字列で入力してください');
  });

  it('項目が特定できない (本文がオブジェクトでない) ときは汎用の文言', async () => {
    expect(await messageFor(CreateOrgInviteRequestBodySchema, null)).toBe('リクエストボディが不正です');
    expect(await messageFor(CreateOrgInviteRequestBodySchema, 'text')).toBe('リクエストボディが不正です');
  });
});

// #1433: 組織の招待メールの「このリンクは YYYY-MM-DD まで有効です」の日付は、期限の時刻 (expires_at。timestamptz) が属する JST の暦日。
// 以前は expires_at.substring(0, 10) (UTC の暦日) で、期限が JST 0:00〜8:59 のとき 1 日早い日付を書いていた。
describe('createOrgInviteWithEmail: 招待メールの期限の日付は JST の暦日 (#1433)', () => {
  const withExpiresAt = (expiresAt: string, isExistingUser = false) => {
    mockRpc.mockImplementation(async (fn: string) => {
      if (fn === 'create_org_invite') return { data: { ...inviteRow, expires_at: expiresAt }, error: null };
      if (fn === 'get_invite_details') return { data: { is_existing_user: isExistingUser }, error: null };
      throw new Error(`unexpected rpc: ${fn}`);
    });
  };
  const invite = () =>
    createOrgInviteWithEmail({
      supabase: makeSupabase(),
      inviter,
      organizationId,
      email: 'taro@example.com',
      role: 'member',
    });
  const sentText = () => {
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    return String((mockSendEmail.mock.calls[0][0] as { text: string }).text);
  };

  it.each([
    // [期限の時刻 (PostgREST が返す timestamptz の形), メールに書く日付, 以前の substring(0, 10)]
    ['2026-10-16T15:00:00+00:00', '2026-10-17', '2026-10-16'], // JST 10/17 0:00 ちょうど
    ['2026-10-16T23:59:59+00:00', '2026-10-17', '2026-10-16'], // JST 10/17 8:59:59
    ['2026-10-17T14:59:59+00:00', '2026-10-17', '2026-10-17'], // JST 10/17 23:59:59
    ['2026-10-31T15:00:00+00:00', '2026-11-01', '2026-10-31'], // 月初 (JST 11/1 0:00)
    ['2026-12-31T15:00:00+00:00', '2027-01-01', '2026-12-31'], // 年始 (JST 1/1 0:00)
  ])('期限 %s → メールは「%s まで有効」(以前は %s)。実行環境のタイムゾーンによらない', async (expiresAt, expected, legacy) => {
    for (const tz of TEST_TIME_ZONES) {
      mockSendEmail.mockClear();
      withExpiresAt(expiresAt);
      const result = await withTimeZoneAsync(tz, invite);
      expect(result.ok, tz).toBe(true);
      const text = sentText();
      expect(text, tz).toContain(`このリンクは ${expected} まで有効です。`);
      if (legacy !== expected) expect(text, tz).not.toContain(`このリンクは ${legacy} まで有効です。`);
    }
  });

  it('既存ユーザー向けのメールも同じ日付 (JST の暦日)', async () => {
    withExpiresAt('2026-10-16T15:00:00+00:00', true);
    const result = await invite();
    expect(result.ok).toBe(true);
    expect(sentText()).toContain('このリンクは 2026-10-17 まで有効です。');
  });

  it('戻り値の招待の expires_at は DB の時刻のまま (日付にしない)', async () => {
    withExpiresAt('2026-10-16T15:00:00+00:00');
    const result = await invite();
    expect(result.ok && result.invite.expires_at).toBe('2026-10-16T15:00:00+00:00');
  });

  it('期限の時刻が読めない値なら、メールだけ送らず警告に残し、招待は作れたことを返す', async () => {
    withExpiresAt('not-a-time');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await invite();
    expect(result.ok).toBe(true);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('メール送信失敗'), expect.any(RangeError));
    warn.mockRestore();
  });
});

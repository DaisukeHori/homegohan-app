import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RateLimitCategory, RateLimitResult } from '@/lib/rate-limit';

// #1163 招待メール等の送信回数制限 (invite-throttle) の単体テスト。
// 限度値そのものは tests/ai-rate-limit-contracts.test.ts と invite-throttle.in-memory.test.ts で確かめる。
// ここでは limiter を差し替え、判定の順序・鍵の作り方・文言・ログ・fail-closed を確かめる。

const mockCheckRateLimit = vi.fn();

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

// 構造化ログのモック
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();
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

const {
  checkInviteEmailLimits,
  checkTransferProposeLimit,
  hashRecipientEmail,
  inviteThrottleFailureFromRpcError,
  inviteThrottleResponse,
  throttleMessageForWindow,
} = await import('@/lib/membership/invite-throttle');

const userId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const scopeId = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const email = 'Taro@Example.com';
const emailHash = createHash('sha256').update('taro@example.com').digest('hex').slice(0, 32);

const BURST_MESSAGE = '短時間に操作が集中しています。1分ほど待ってからお試しください。';
const DAILY_MESSAGE = '本日の送信上限に達しました。しばらく時間をおいてからお試しください。';

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

const calledCategories = () => mockCheckRateLimit.mock.calls.map((c) => c[1]);

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockReset();
  limiter({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('hashRecipientEmail', () => {
  it('前後の空白を除き小文字にした SHA-256 の先頭 32 文字を返す', () => {
    expect(hashRecipientEmail('Taro@Example.com')).toBe(emailHash);
    expect(hashRecipientEmail('  taro@example.com\n')).toBe(emailHash);
    expect(hashRecipientEmail('TARO@EXAMPLE.COM')).toBe(emailHash);
    expect(emailHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('別のアドレスは別のハッシュになり、アドレス自体は含まれない', () => {
    expect(hashRecipientEmail('jiro@example.com')).not.toBe(emailHash);
    expect(hashRecipientEmail('taro@example.com')).not.toContain('@');
  });
});

describe('throttleMessageForWindow', () => {
  it('分あたり (60 秒以下) の超過は「1分ほど待って」の文言', () => {
    expect(throttleMessageForWindow(60)).toBe(BURST_MESSAGE);
    expect(throttleMessageForWindow(10)).toBe(BURST_MESSAGE);
  });

  it('日次などそれより長いウィンドウの超過は「本日の上限」の文言', () => {
    expect(throttleMessageForWindow(24 * 60 * 60)).toBe(DAILY_MESSAGE);
    expect(throttleMessageForWindow(61)).toBe(DAILY_MESSAGE);
  });

  it('ウィンドウが分からないときは日次の文言にする', () => {
    expect(throttleMessageForWindow(undefined)).toBe(DAILY_MESSAGE);
  });

  it('宛先が登録済みかどうかを推測させる語を含まない', () => {
    for (const message of [BURST_MESSAGE, DAILY_MESSAGE]) {
      expect(message).not.toMatch(/登録|存在|アカウント|既に|すでに/);
    }
  });
});

describe('checkInviteEmailLimits: 判定の順序と鍵', () => {
  it('family-invite: 招待者 → 宛先の順に判定し、組織用の枠は使わない', async () => {
    const failure = await checkInviteEmailLimits({ flow: 'family-invite', userId, scopeId, recipientEmail: email });

    expect(failure).toBeNull();
    expect(mockCheckRateLimit.mock.calls).toEqual([
      [userId, 'family-invite'],
      [`family-invite:${scopeId}:${emailHash}`, 'invite-target'],
    ]);
  });

  it('org-invite: 招待者 → 組織 → 宛先の順に判定する', async () => {
    const failure = await checkInviteEmailLimits({ flow: 'org-invite', userId, scopeId, recipientEmail: email });

    expect(failure).toBeNull();
    expect(mockCheckRateLimit.mock.calls).toEqual([
      [userId, 'org-invite'],
      [scopeId, 'org-invite-scope'],
      [`org-invite:${scopeId}:${emailHash}`, 'invite-target'],
    ]);
  });

  it('child-promotion: 招待者 → 宛先の順に判定する (宛先の範囲は呼び出し側が渡した scopeId = user.id)', async () => {
    const failure = await checkInviteEmailLimits({ flow: 'child-promotion', userId, scopeId: userId, recipientEmail: email });

    expect(failure).toBeNull();
    expect(mockCheckRateLimit.mock.calls).toEqual([
      [userId, 'child-promotion'],
      [`child-promotion:${userId}:${emailHash}`, 'invite-target'],
    ]);
  });

  it('宛先の鍵にメールアドレス (@ を含む文字列) を含めない', async () => {
    await checkInviteEmailLimits({ flow: 'org-invite', userId, scopeId, recipientEmail: email });

    for (const [key] of mockCheckRateLimit.mock.calls) {
      expect(key).not.toContain('@');
      expect(String(key).toLowerCase()).not.toContain('taro');
    }
  });

  it('大文字小文字・前後の空白が違うだけの宛先は同じ鍵になる', async () => {
    await checkInviteEmailLimits({ flow: 'family-invite', userId, scopeId, recipientEmail: 'Foo@x.com ' });
    await checkInviteEmailLimits({ flow: 'family-invite', userId, scopeId, recipientEmail: 'foo@x.com' });

    const targetKeys = mockCheckRateLimit.mock.calls.filter((c) => c[1] === 'invite-target').map((c) => c[0]);
    expect(targetKeys).toHaveLength(2);
    expect(targetKeys[0]).toBe(targetKeys[1]);
  });

  it('範囲 (flow / scopeId) が違えば同じ宛先でも別の鍵になる', async () => {
    await checkInviteEmailLimits({ flow: 'family-invite', userId, scopeId, recipientEmail: email });
    await checkInviteEmailLimits({ flow: 'org-invite', userId, scopeId, recipientEmail: email });
    await checkInviteEmailLimits({
      flow: 'family-invite',
      userId,
      scopeId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
      recipientEmail: email,
    });

    const targetKeys = mockCheckRateLimit.mock.calls.filter((c) => c[1] === 'invite-target').map((c) => c[0]);
    expect(new Set(targetKeys).size).toBe(3);
  });
});

describe('checkInviteEmailLimits: 超過したら打ち切る', () => {
  it('招待者の枠が超過: 失敗を返し、組織・宛先の枠は判定しない', async () => {
    limiter({ 'org-invite': deny(60) });

    const failure = await checkInviteEmailLimits({ flow: 'org-invite', userId, scopeId, recipientEmail: email });

    expect(failure).not.toBeNull();
    expect(calledCategories()).toEqual(['org-invite']);
  });

  it('組織の枠が超過: 宛先の枠は判定しない', async () => {
    limiter({ 'org-invite-scope': deny(24 * 60 * 60) });

    const failure = await checkInviteEmailLimits({ flow: 'org-invite', userId, scopeId, recipientEmail: email });

    expect(failure).not.toBeNull();
    expect(calledCategories()).toEqual(['org-invite', 'org-invite-scope']);
  });

  it('宛先の枠だけが超過: 招待者の枠を通っても失敗を返す', async () => {
    limiter({ 'invite-target': deny(24 * 60 * 60) });

    const failure = await checkInviteEmailLimits({ flow: 'family-invite', userId, scopeId, recipientEmail: email });

    expect(failure).not.toBeNull();
    expect(calledCategories()).toEqual(['family-invite', 'invite-target']);
  });

  it('失敗情報: 分あたりの超過は retryAfterSec と「1分ほど待って」の文言', async () => {
    limiter({ 'family-invite': deny(60, 42) });

    const failure = await checkInviteEmailLimits({ flow: 'family-invite', userId, scopeId, recipientEmail: email });

    expect(failure).toEqual({ retryAfterSec: expect.any(Number), windowSec: 60, message: BURST_MESSAGE });
    // 判定時刻とのずれ (CI の遅延) を見込んで下限にゆとりを持たせる
    expect(failure!.retryAfterSec).toBeGreaterThanOrEqual(32);
    expect(failure!.retryAfterSec).toBeLessThanOrEqual(42);
  });

  it('失敗情報: 日次の超過は「本日の上限」の文言で windowSec は 86400', async () => {
    limiter({ 'family-invite': deny(24 * 60 * 60, 7200) });

    const failure = await checkInviteEmailLimits({ flow: 'family-invite', userId, scopeId, recipientEmail: email });

    expect(failure).toMatchObject({ windowSec: 86400, message: DAILY_MESSAGE });
    expect(failure!.retryAfterSec).toBeGreaterThanOrEqual(7100);
  });

  it('宛先の超過は日次の文言になる (宛先の登録状況を推測させない)', async () => {
    limiter({ 'invite-target': deny(24 * 60 * 60) });

    const failure = await checkInviteEmailLimits({ flow: 'child-promotion', userId, scopeId: userId, recipientEmail: email });

    expect(failure!.message).toBe(DAILY_MESSAGE);
  });

  it('reset が過去でも retryAfterSec は 1 秒以上にする', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({
      success: false,
      limit: 5,
      remaining: 0,
      reset: Date.now() - 5_000,
      windowSec: 60,
    });

    const failure = await checkInviteEmailLimits({ flow: 'family-invite', userId, scopeId, recipientEmail: email });

    expect(failure!.retryAfterSec).toBe(1);
  });
});

describe('checkInviteEmailLimits: ログ', () => {
  it('超過したら withUser(userId).warn に flow / 判定の種類 / ウィンドウ / 宛先ハッシュの先頭だけを残す', async () => {
    limiter({ 'invite-target': deny(24 * 60 * 60) });

    await checkInviteEmailLimits({ flow: 'org-invite', userId, scopeId, recipientEmail: email });

    expect(mockWithUser).toHaveBeenCalledWith(userId);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [message, metadata] = mockLogWarn.mock.calls[0];
    expect(message).toBe('メール送信の上限に達しました');
    expect(metadata).toMatchObject({
      flow: 'org-invite',
      layer: 'target',
      window_sec: 86400,
      recipient_hash: emailHash.slice(0, 8),
    });
    // メールアドレスもフルのハッシュもログに出さない
    const serialized = JSON.stringify(mockLogWarn.mock.calls);
    expect(serialized).not.toContain('@');
    expect(serialized.toLowerCase()).not.toContain('taro');
    expect(serialized).not.toContain(emailHash);
  });

  it('招待者の枠・組織の枠の超過も、どの判定で止まったか (layer) を残す', async () => {
    limiter({ 'org-invite': deny(60) });
    await checkInviteEmailLimits({ flow: 'org-invite', userId, scopeId, recipientEmail: email });
    limiter({ 'org-invite-scope': deny(86400) });
    await checkInviteEmailLimits({ flow: 'org-invite', userId, scopeId, recipientEmail: email });

    expect(mockLogWarn.mock.calls.map((c) => c[1].layer)).toEqual(['user', 'scope']);
  });

  it('通ったときは警告ログを出さない', async () => {
    await checkInviteEmailLimits({ flow: 'family-invite', userId, scopeId, recipientEmail: email });

    expect(mockLogWarn).not.toHaveBeenCalled();
  });
});

describe('checkInviteEmailLimits: fail-closed', () => {
  it('limiter が例外を投げたら握りつぶさず同じ例外を伝播し、構造化ログに残す', async () => {
    const backendError = new Error('ECONNREFUSED: upstash unreachable');
    mockCheckRateLimit.mockRejectedValue(backendError);

    await expect(
      checkInviteEmailLimits({ flow: 'family-invite', userId, scopeId, recipientEmail: email }),
    ).rejects.toBe(backendError);

    expect(mockWithUser).toHaveBeenCalledWith(userId);
    expect(mockLogError).toHaveBeenCalledWith(
      'レート制限の判定に失敗しました (fail-closed)',
      backendError,
      { flow: 'family-invite', layer: 'user' },
    );
    // 例外のあとで次の枠の判定を続けない
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
  });

  it('宛先の判定で例外が出ても通さない', async () => {
    const backendError = new Error('redis timeout');
    mockCheckRateLimit.mockResolvedValueOnce(allow()).mockRejectedValueOnce(backendError);

    await expect(
      checkInviteEmailLimits({ flow: 'family-invite', userId, scopeId, recipientEmail: email }),
    ).rejects.toBe(backendError);
    expect(mockLogError).toHaveBeenCalledWith(expect.any(String), backendError, {
      flow: 'family-invite',
      layer: 'target',
    });
  });

  it.each([
    ['userId', { userId: '', scopeId }],
    ['scopeId', { userId, scopeId: '' }],
  ])('%s が空なら全員で枠を共有してしまうので、limiter を呼ばずに例外にする', async (_name, ids) => {
    await expect(
      checkInviteEmailLimits({ flow: 'org-invite', recipientEmail: email, ...ids }),
    ).rejects.toThrow('invite-throttle');
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});

describe('checkTransferProposeLimit', () => {
  it('提案者の user.id を鍵に transfer-propose だけを判定する', async () => {
    const failure = await checkTransferProposeLimit(userId);

    expect(failure).toBeNull();
    expect(mockCheckRateLimit.mock.calls).toEqual([[userId, 'transfer-propose']]);
  });

  it('超過したら失敗情報を返し、flow=transfer-propose で警告ログを残す', async () => {
    limiter({ 'transfer-propose': deny(60, 20) });

    const failure = await checkTransferProposeLimit(userId);

    expect(failure).toMatchObject({ windowSec: 60, message: BURST_MESSAGE });
    expect(mockWithUser).toHaveBeenCalledWith(userId);
    expect(mockLogWarn.mock.calls[0][1]).toMatchObject({ flow: 'transfer-propose', layer: 'user' });
  });

  it('limiter が例外を投げたら伝播する (fail-closed)', async () => {
    const backendError = new Error('ECONNREFUSED');
    mockCheckRateLimit.mockRejectedValue(backendError);

    await expect(checkTransferProposeLimit(userId)).rejects.toBe(backendError);
    expect(mockLogError).toHaveBeenCalledTimes(1);
  });

  it('userId が空なら limiter を呼ばずに例外にする', async () => {
    await expect(checkTransferProposeLimit('')).rejects.toThrow('invite-throttle');
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});

describe('inviteThrottleFailureFromRpcError: DB の 24 時間上限 (#1163)', () => {
  // enforce_membership_daily_cap が RAISE する RATE_LIMITED を PostgREST が返した形
  const dbRateLimited = (overrides: Record<string, unknown> = {}) => ({
    message: 'RATE_LIMITED',
    code: 'P0001',
    details: 'org_invite:per_target',
    hint: 'retry_after_sec=1234',
    ...overrides,
  });
  const context = { flow: 'org-invite', userId } as const;

  it('RATE_LIMITED: HINT の秒数を retryAfterSec にし、日次の文言とウィンドウ 86400 秒を返す', () => {
    const failure = inviteThrottleFailureFromRpcError(dbRateLimited(), context);

    expect(failure).toEqual({ retryAfterSec: 1234, windowSec: 86400, message: DAILY_MESSAGE });
  });

  it('返した失敗情報は inviteThrottleResponse でアプリ層の上限と同じ形の 429 になる', async () => {
    const res = inviteThrottleResponse(inviteThrottleFailureFromRpcError(dbRateLimited(), context)!);
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('1234');
    expect(json).toEqual({ error: { code: 'RATE_LIMITED', message: DAILY_MESSAGE, retryAfter: 1234 } });
  });

  it.each([
    ['HINT が無い', { hint: null }],
    ['HINT が undefined', { hint: undefined }],
    ['HINT が空文字', { hint: '' }],
    ['HINT が想定外の文字列', { hint: 'try again later' }],
    ['秒数が 0', { hint: 'retry_after_sec=0' }],
    ['秒数が数字でない', { hint: 'retry_after_sec=abc' }],
    ['秒数が負', { hint: 'retry_after_sec=-5' }],
  ])('%s: retryAfterSec は 1 時間にする', (_label, overrides) => {
    const failure = inviteThrottleFailureFromRpcError(dbRateLimited(overrides), context);

    expect(failure).toMatchObject({ retryAfterSec: 3600, windowSec: 86400 });
  });

  it('HINT に他の文言が混じっていても retry_after_sec の秒数を読む', () => {
    const failure = inviteThrottleFailureFromRpcError(dbRateLimited({ hint: 'cap; retry_after_sec=77.' }), context);

    expect(failure!.retryAfterSec).toBe(77);
  });

  it('message が RATE_LIMITED を含んでいれば SQLSTATE が無くても対象にする (PostgREST のメッセージ前置きを許す)', () => {
    expect(inviteThrottleFailureFromRpcError(dbRateLimited({ code: undefined }), context)).not.toBeNull();
    expect(
      inviteThrottleFailureFromRpcError(dbRateLimited({ message: 'ERROR: RATE_LIMITED', code: null }), context),
    ).not.toBeNull();
  });

  it.each([
    ['別のコード (NOT_ORG_ADMIN)', { message: 'NOT_ORG_ADMIN' }],
    ['別のコード (SEAT_LIMIT_EXCEEDED)', { message: 'SEAT_LIMIT_EXCEEDED' }],
    ['別のコード (MEMBER_LIMIT_EXCEEDED)', { message: 'MEMBER_LIMIT_EXCEEDED' }],
    ['想定外のエラー', { message: 'connection refused', code: '08006' }],
    ['デッドロック (40P01)', { message: 'deadlock detected', code: '40P01' }],
    ['message が null', { message: null }],
    ['message が無い', { message: undefined }],
  ])('RATE_LIMITED 以外 (%s) は null を返し、ログも残さない', (_label, overrides) => {
    const failure = inviteThrottleFailureFromRpcError(dbRateLimited(overrides), context);

    expect(failure).toBeNull();
    expect(mockWithUser).not.toHaveBeenCalled();
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('withUser(userId).warn に flow / layer=db / 上限名 / 秒数を残す (メールアドレスは残さない)', () => {
    inviteThrottleFailureFromRpcError(dbRateLimited(), { flow: 'family-invite', userId });

    expect(mockWithUser).toHaveBeenCalledWith(userId);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [message, metadata] = mockLogWarn.mock.calls[0];
    expect(message).toBe('DB の 24 時間上限に達しました');
    expect(metadata).toEqual({
      flow: 'family-invite',
      layer: 'db',
      window_sec: 86400,
      retry_after_sec: 1234,
      rule: 'org_invite:per_target',
    });
    expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain('@');
  });

  it('上限名 (DETAIL) が想定の形でなければログに残さない (メールアドレスなどを紛れ込ませない)', () => {
    inviteThrottleFailureFromRpcError(dbRateLimited({ details: 'taro@example.com' }), context);
    inviteThrottleFailureFromRpcError(dbRateLimited({ details: null }), context);

    expect(mockLogWarn).toHaveBeenCalledTimes(2);
    for (const [, metadata] of mockLogWarn.mock.calls) {
      expect(metadata).not.toHaveProperty('rule');
    }
    expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain('taro');
  });

  it('譲渡提案 (transfer-propose) の flow も記録できる', () => {
    inviteThrottleFailureFromRpcError(dbRateLimited({ details: 'transfer_propose:per_actor' }), {
      flow: 'transfer-propose',
      userId,
    });

    expect(mockLogWarn.mock.calls[0][1]).toMatchObject({ flow: 'transfer-propose', rule: 'transfer_propose:per_actor' });
  });
});

describe('inviteThrottleResponse', () => {
  it('429 と Retry-After ヘッダー、UI が読む入れ子の本文 { error: { code, message, retryAfter } } を返す', async () => {
    const res = inviteThrottleResponse({ retryAfterSec: 37, windowSec: 60, message: BURST_MESSAGE });
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('37');
    expect(json).toEqual({
      error: { code: 'RATE_LIMITED', message: BURST_MESSAGE, retryAfter: 37 },
    });
  });

  it('AI 系の平らな形式 (トップレベルの code / retryAfter) にはしない', async () => {
    const json = await inviteThrottleResponse({ retryAfterSec: 5, windowSec: 60, message: BURST_MESSAGE }).json();

    expect(json).not.toHaveProperty('code');
    expect(json).not.toHaveProperty('retryAfter');
    expect(typeof json.error).toBe('object');
  });
});

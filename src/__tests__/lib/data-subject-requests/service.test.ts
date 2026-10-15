// @vitest-environment node
/**
 * #1178 個人情報の請求 (DSR) の DB の読み書き src/lib/data-subject-requests/service.ts の単体テスト
 * (設計 cross/15 §6・§7・§8.3)。
 *
 * DB は fake-dsr-db.ts (絞り込みを実際に適用する簡易 PostgREST)。メール (notifications.ts)・ニックネーム (fetchNicknames)・
 * メールアドレス (fetchUserEmails) はモックする。route の検査の順序 (401 / 403 / 400 / 429) は段 B・C の route テストが受け持つ。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DSR_ADMIN_COLUMNS,
  DSR_ADMIN_LIST_COLUMNS,
  DSR_OPEN_STATUSES,
  DSR_OWN_COLUMNS,
  DSR_OWN_LIST_LIMIT,
  DSR_REQUESTER_ACTION_COLUMNS,
  DSR_STATUSES,
  DSR_VERIFICATION_MAX_SENDS,
  type DsrStatus,
} from '@/lib/data-subject-requests/core';
import { hashDsrVerificationToken } from '@/lib/data-subject-requests/tokens';
import { FakeDsrDb, type FakeRow } from './fake-dsr-db';

const notifications = vi.hoisted(() => ({
  sendDsrVerificationEmail: vi.fn(async () => undefined),
  sendDsrReceivedEmail: vi.fn(async () => undefined),
  sendDsrOperatorNotice: vi.fn(async () => undefined),
  sendDsrResolvedEmail: vi.fn(async () => undefined),
}));
vi.mock('@/lib/data-subject-requests/notifications', () => notifications);

const fetchNicknamesMock = vi.hoisted(() => vi.fn(async () => new Map<string, string>()));
vi.mock('@/lib/admin/inquiries', () => ({ fetchNicknames: fetchNicknamesMock }));
const fetchUserEmailsMock = vi.hoisted(() => vi.fn(async () => new Map<string, string>()));
vi.mock('@/lib/admin/user-emails', () => ({ fetchUserEmails: fetchUserEmailsMock }));

import {
  createDsr,
  getDsrForOperator,
  getOwnDsr,
  listDsrForOperator,
  listOwnDsr,
  resendDsrVerification,
  updateDsrByOperator,
  verifyDsr,
  withdrawDsr,
  type DsrContext,
  type DsrLogger,
} from '@/lib/data-subject-requests/service';

const NOW = new Date('2026-10-20T00:00:00.000Z');
const SITE = 'https://site.example.test';
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'd'.repeat(64);
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const DUE_DAYS = 30;

let db: FakeDsrDb;
let ctx: DsrContext;
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

const admin = () => db.client('admin');
const user = () => db.client('user');

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

/** 本人確認待ちの行 (トークンは TOKEN、期限は 1 時間後) */
function seedPending(overrides: FakeRow = {}): FakeRow {
  return db.seed({
    user_id: ME,
    status: 'pending_verification',
    verification_token_hash: hashDsrVerificationToken(TOKEN),
    verification_sent_at: iso(-MS_PER_HOUR),
    verification_expires_at: iso(MS_PER_HOUR),
    verification_send_count: 1,
    ...overrides,
  });
}

/** 本人確認が済んだ行 (受付済み以降) */
function seedVerified(status: DsrStatus, overrides: FakeRow = {}): FakeRow {
  const terminal = status === 'fulfilled' || status === 'rejected' || status === 'withdrawn';
  return db.seed({
    user_id: ME,
    status,
    verification_token_hash: null,
    verified_at: iso(-MS_PER_DAY),
    due_at: iso(DUE_DAYS * MS_PER_DAY),
    resolved_at: terminal ? iso(-MS_PER_HOUR) : null,
    response_note: terminal && status !== 'withdrawn' ? '前の応答' : null,
    ...overrides,
  });
}

beforeEach(() => {
  db = new FakeDsrDb();
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  ctx = { now: NOW, requestId: 'req-1', log: log as unknown as DsrLogger };
  for (const fn of Object.values(notifications)) fn.mockClear();
  fetchNicknamesMock.mockReset();
  fetchNicknamesMock.mockResolvedValue(new Map());
  fetchUserEmailsMock.mockReset();
  fetchUserEmailsMock.mockResolvedValue(new Map());
  vi.stubEnv('NEXT_PUBLIC_APP_URL', SITE);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function expectNoEmails(): void {
  for (const [name, fn] of Object.entries(notifications)) expect(fn, name).not.toHaveBeenCalled();
}

// ─────────────────────────────────────────────────────────────────────────────
// 本人の読み取り
// ─────────────────────────────────────────────────────────────────────────────

describe('listOwnDsr', () => {
  it('本人のセッションの client で DSR_OWN_COLUMNS を user_id で絞って新しい順に最大 DSR_OWN_LIST_LIMIT 件読む (他人の行が見える client でも自分の行だけ)', async () => {
    const mine = seedVerified('received');
    seedVerified('in_progress', { user_id: OTHER });
    const newer = seedPending({ request_type: 'erasure' });

    const result = await listOwnDsr(user(), ME, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((r) => r.id)).toEqual([newer.id, mine.id]);
    const [call] = db.callsOf('select', 'user');
    expect(call.columns).toBe(DSR_OWN_COLUMNS);
    expect(call.filters).toEqual([{ kind: 'eq', column: 'user_id', value: ME }]);
    expect(call.orders).toEqual([
      { column: 'created_at', ascending: false, nullsFirst: undefined },
      { column: 'id', ascending: false, nullsFirst: undefined },
    ]);
    expect(call.limit).toBe(DSR_OWN_LIST_LIMIT);
    expect(db.callsOf('select', 'admin')).toHaveLength(0);
    for (const dto of result.data) {
      expect(dto).not.toHaveProperty('verification_token_hash');
      expect(dto).not.toHaveProperty('admin_notes');
    }
  });

  it('期限切れの本人確認待ちは verification_expired = true', async () => {
    seedPending({ verification_expires_at: iso(-1) });
    const result = await listOwnDsr(user(), ME, ctx);
    expect(result.ok && result.data[0].verification_expired).toBe(true);
  });

  it('DB の失敗は 500 INTERNAL_ERROR (cause に元のエラー。生の文は code にも status にも入れない)', async () => {
    db.failNext.select = { code: 'XX000', message: 'raw db failure text' };
    const result = await listOwnDsr(user(), ME, ctx);
    expect(result).toEqual({
      ok: false,
      status: 500,
      code: 'INTERNAL_ERROR',
      cause: { code: 'XX000', message: 'raw db failure text' },
    });
  });
});

describe('getOwnDsr', () => {
  it('自分の行は 200 (DSR_OWN_COLUMNS を id と user_id の両方で絞って読む)', async () => {
    const row = seedVerified('fulfilled', { response_note: '応答の本文', admin_notes: '内部メモ' });
    const result = await getOwnDsr(user(), ME, String(row.id), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ id: row.id, status: 'fulfilled', response_note: '応答の本文' });
    expect(result.data).not.toHaveProperty('admin_notes');
    const [call] = db.callsOf('select', 'user');
    expect(call.columns).toBe(DSR_OWN_COLUMNS);
    expect(call.filters).toEqual([
      { kind: 'eq', column: 'id', value: row.id },
      { kind: 'eq', column: 'user_id', value: ME },
    ]);
  });

  it('他人の行・退会済みの行・無い行は 404 NOT_FOUND', async () => {
    const others = seedVerified('received', { user_id: OTHER });
    const deleted = seedVerified('received', { user_id: null });
    for (const id of [String(others.id), String(deleted.id), '33333333-3333-4333-8333-333333333333']) {
      expect(await getOwnDsr(user(), ME, id, ctx)).toEqual({ ok: false, status: 404, code: 'NOT_FOUND' });
    }
  });

  it('DB の失敗は 500', async () => {
    db.failNext.select = { code: 'XX000', message: 'x' };
    const result = await getOwnDsr(user(), ME, '33333333-3333-4333-8333-333333333333', ctx);
    expect(result).toMatchObject({ ok: false, status: 500, code: 'INTERNAL_ERROR' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 作成
// ─────────────────────────────────────────────────────────────────────────────

describe('createDsr', () => {
  it('本人確認待ちの行を作り (生のトークンは保存しない)、本人確認メールを 1 通送る', async () => {
    const result = await createDsr(
      admin(),
      { userId: ME, input: { request_type: 'disclosure', details: '開示してください' }, siteUrl: SITE },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(db.rows).toHaveLength(1);
    const stored = db.rows[0];
    expect(stored).toMatchObject({
      user_id: ME,
      request_type: 'disclosure',
      details: '開示してください',
      status: 'pending_verification',
      verification_method: 'email_link',
      verification_sent_at: NOW.toISOString(),
      verification_expires_at: iso(24 * MS_PER_HOUR),
      verification_send_count: 1,
      verified_at: null,
      due_at: null,
    });
    expect(stored.verification_token_hash).toMatch(/^[0-9a-f]{64}$/);

    expect(notifications.sendDsrVerificationEmail).toHaveBeenCalledTimes(1);
    const [client, row, token, siteUrl, logger] = notifications.sendDsrVerificationEmail.mock.calls[0] as unknown as [
      unknown,
      FakeRow,
      string,
      string,
      unknown,
    ];
    expect(client).toBeDefined();
    expect(row.id).toBe(stored.id);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDsrVerificationToken(token)).toBe(stored.verification_token_hash);
    expect(token).not.toBe(stored.verification_token_hash);
    expect(siteUrl).toBe(SITE);
    expect(logger).toBe(ctx.log);

    // 応答は本人の列だけ (hash を返さない)
    expect(result.data).not.toHaveProperty('verification_token_hash');
    expect(result.data).toMatchObject({ id: stored.id, status: 'pending_verification', verification_expired: false });
    const [insert] = db.callsOf('insert', 'admin');
    expect(insert.columns).toBe(DSR_OWN_COLUMNS);
    expect(db.callsOf('insert', 'user')).toHaveLength(0);
  });

  it('同じ種類の開いている請求があると 23505 → 409 DSR_ALREADY_OPEN (行は増えず、メールも送らない)', async () => {
    seedVerified('in_progress', { request_type: 'erasure' });
    const result = await createDsr(admin(), { userId: ME, input: { request_type: 'erasure', details: 'x' }, siteUrl: SITE }, ctx);
    expect(result).toMatchObject({ ok: false, status: 409, code: 'DSR_ALREADY_OPEN' });
    expect(db.rows).toHaveLength(1);
    expectNoEmails();
  });

  it('終わった請求・別の種類・他人の請求があっても作れる', async () => {
    seedVerified('fulfilled', { request_type: 'erasure' });
    seedPending({ request_type: 'disclosure' });
    seedPending({ request_type: 'erasure', user_id: OTHER });
    const result = await createDsr(admin(), { userId: ME, input: { request_type: 'erasure', details: 'x' }, siteUrl: SITE }, ctx);
    expect(result.ok).toBe(true);
  });

  it('23505 以外の DB の失敗は 500 (メールを送らない)', async () => {
    db.failNext.insert = { code: '23514', message: 'check violation raw text' };
    const result = await createDsr(admin(), { userId: ME, input: { request_type: 'disclosure', details: 'x' }, siteUrl: SITE }, ctx);
    expect(result).toMatchObject({ ok: false, status: 500, code: 'INTERNAL_ERROR' });
    expectNoEmails();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 本人確認
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyDsr', () => {
  const verify = (id: unknown, token = TOKEN, userId = ME) =>
    verifyDsr(admin(), { userId, id: String(id), token, dueDays: DUE_DAYS }, ctx);

  it('一致・期限内 → received (verified_at = now・due_at = now + dueDays 日・hash = NULL)・メール 2 通', async () => {
    const row = seedPending();

    const result = await verify(row.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(db.find(row.id)).toMatchObject({
      status: 'received',
      verified_at: NOW.toISOString(),
      due_at: iso(DUE_DAYS * MS_PER_DAY),
      verification_token_hash: null,
    });
    expect(result.data).toMatchObject({ status: 'received', due_at: iso(DUE_DAYS * MS_PER_DAY) });
    expect(result.data).not.toHaveProperty('verification_token_hash');

    const [read] = db.callsOf('select', 'admin');
    expect(read.columns).toBe(DSR_REQUESTER_ACTION_COLUMNS);
    expect(read.filters).toEqual([
      { kind: 'eq', column: 'id', value: row.id },
      { kind: 'eq', column: 'user_id', value: ME },
    ]);
    const [update] = db.callsOf('update', 'admin');
    expect(update.columns).toBe(DSR_OWN_COLUMNS);
    expect(update.filters).toEqual([
      { kind: 'eq', column: 'id', value: row.id },
      { kind: 'eq', column: 'user_id', value: ME },
      { kind: 'eq', column: 'status', value: 'pending_verification' },
      { kind: 'eq', column: 'verification_token_hash', value: hashDsrVerificationToken(TOKEN) },
    ]);

    expect(notifications.sendDsrReceivedEmail).toHaveBeenCalledTimes(1);
    expect(notifications.sendDsrOperatorNotice).toHaveBeenCalledTimes(1);
    const receivedArgs = notifications.sendDsrReceivedEmail.mock.calls[0] as unknown as [unknown, FakeRow, string, unknown];
    expect(receivedArgs[1]).toMatchObject({ id: row.id, status: 'received', due_at: iso(DUE_DAYS * MS_PER_DAY) });
    expect(receivedArgs[2]).toBe(SITE);
    const noticeArgs = notifications.sendDsrOperatorNotice.mock.calls[0] as unknown as [FakeRow, string, unknown];
    expect(noticeArgs[0]).toMatchObject({ id: row.id, status: 'received' });
    expect(noticeArgs[1]).toBe(SITE);
    expect(notifications.sendDsrVerificationEmail).not.toHaveBeenCalled();
  });

  it('dueDays を期限に使う', async () => {
    const row = seedPending();
    await verifyDsr(admin(), { userId: ME, id: String(row.id), token: TOKEN, dueDays: 7 }, ctx);
    expect(db.find(row.id)?.due_at).toBe(iso(7 * MS_PER_DAY));
  });

  it('他人の行・退会済みの行・無い行は 404 (書き込みもメールも無し)', async () => {
    const others = seedPending({ user_id: OTHER });
    const deleted = seedPending({ user_id: null });
    for (const id of [others.id, deleted.id, '33333333-3333-4333-8333-333333333333']) {
      expect(await verify(id)).toEqual({ ok: false, status: 404, code: 'NOT_FOUND' });
    }
    expect(db.callsOf('update')).toHaveLength(0);
    expectNoEmails();
  });

  it.each(['received', 'in_progress', 'fulfilled', 'rejected', 'withdrawn'] as const)(
    '%s は 409 DSR_INVALID_STATE (期限切れ・不一致より先に判定。書き込みもメールも無し)',
    async (status) => {
      const row = seedVerified(status, {
        verification_token_hash: hashDsrVerificationToken(TOKEN),
        verification_expires_at: iso(-MS_PER_DAY),
      });
      expect(await verify(row.id, 'e'.repeat(64))).toEqual({ ok: false, status: 409, code: 'DSR_INVALID_STATE' });
      expect(db.callsOf('update')).toHaveLength(0);
      expectNoEmails();
    },
  );

  it('期限切れは 410 DSR_VERIFICATION_EXPIRED (トークンの一致より先。状態は変えない)', async () => {
    const row = seedPending({ verification_expires_at: iso(-1) });
    expect(await verify(row.id, 'e'.repeat(64))).toEqual({ ok: false, status: 410, code: 'DSR_VERIFICATION_EXPIRED' });
    expect(await verify(row.id)).toEqual({ ok: false, status: 410, code: 'DSR_VERIFICATION_EXPIRED' });
    expect(db.find(row.id)?.status).toBe('pending_verification');
    expect(db.callsOf('update')).toHaveLength(0);
    expectNoEmails();
  });

  it('期限ちょうどはまだ有効', async () => {
    const row = seedPending({ verification_expires_at: NOW.toISOString() });
    expect((await verify(row.id)).ok).toBe(true);
  });

  it('トークンが合わない・保存した hash が無いときは 400 DSR_VERIFICATION_INVALID', async () => {
    const row = seedPending();
    expect(await verify(row.id, 'e'.repeat(64))).toEqual({ ok: false, status: 400, code: 'DSR_VERIFICATION_INVALID' });
    // hash そのものを送っても通らない
    expect(await verify(row.id, hashDsrVerificationToken(TOKEN))).toEqual({
      ok: false,
      status: 400,
      code: 'DSR_VERIFICATION_INVALID',
    });
    const noHash = seedPending({ verification_token_hash: null, request_type: 'erasure' });
    expect(await verify(noHash.id)).toEqual({ ok: false, status: 400, code: 'DSR_VERIFICATION_INVALID' });
    expect(db.callsOf('update')).toHaveLength(0);
    expectNoEmails();
  });

  it('判定の後に取り下げられた (同時の操作) → UPDATE が 0 行 → 409 DSR_INVALID_STATE・メールを送らない', async () => {
    const row = seedPending();
    db.beforeUpdate = () => {
      Object.assign(db.find(row.id) ?? {}, { status: 'withdrawn', resolved_at: NOW.toISOString(), verification_token_hash: null });
    };
    expect(await verify(row.id)).toEqual({ ok: false, status: 409, code: 'DSR_INVALID_STATE' });
    expect(db.find(row.id)?.status).toBe('withdrawn');
    expectNoEmails();
  });

  it('判定の後に再送された (hash が変わった) → 409 DSR_INVALID_STATE (古いリンクで受付にしない)', async () => {
    const row = seedPending();
    db.beforeUpdate = () => {
      Object.assign(db.find(row.id) ?? {}, { verification_token_hash: hashDsrVerificationToken('f'.repeat(64)) });
    };
    expect(await verify(row.id)).toEqual({ ok: false, status: 409, code: 'DSR_INVALID_STATE' });
    expect(db.find(row.id)?.status).toBe('pending_verification');
    expectNoEmails();
  });

  it('読み取り・書き込みの DB の失敗は 500 (メールを送らない)', async () => {
    const row = seedPending();
    db.failNext.select = { code: 'XX000', message: 'x' };
    expect(await verify(row.id)).toMatchObject({ ok: false, status: 500, code: 'INTERNAL_ERROR' });
    db.failNext.update = { code: 'XX000', message: 'x' };
    expect(await verify(row.id)).toMatchObject({ ok: false, status: 500, code: 'INTERNAL_ERROR' });
    expectNoEmails();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 確認メールの再送
// ─────────────────────────────────────────────────────────────────────────────

describe('resendDsrVerification', () => {
  const resend = (id: unknown, userId = ME) => resendDsrVerification(admin(), { userId, id: String(id), siteUrl: SITE }, ctx);

  it('新しい hash・送った時刻・期限 (+24 時間)・回数 +1 で書き、新しいトークンで確認メールを送る', async () => {
    const row = seedPending({ verification_send_count: 2 });
    const oldHash = row.verification_token_hash;

    const result = await resend(row.id);

    expect(result.ok).toBe(true);
    const stored = db.find(row.id);
    expect(stored).toMatchObject({
      status: 'pending_verification',
      verification_sent_at: NOW.toISOString(),
      verification_expires_at: iso(24 * MS_PER_HOUR),
      verification_send_count: 3,
    });
    expect(stored?.verification_token_hash).not.toBe(oldHash);
    const [update] = db.callsOf('update', 'admin');
    expect(update.filters).toEqual([
      { kind: 'eq', column: 'id', value: row.id },
      { kind: 'eq', column: 'user_id', value: ME },
      { kind: 'eq', column: 'status', value: 'pending_verification' },
      { kind: 'eq', column: 'verification_send_count', value: 2 },
    ]);
    expect(update.columns).toBe(DSR_OWN_COLUMNS);
    const [read] = db.callsOf('select', 'admin');
    expect(read.columns).toBe(DSR_REQUESTER_ACTION_COLUMNS);

    expect(notifications.sendDsrVerificationEmail).toHaveBeenCalledTimes(1);
    const args = notifications.sendDsrVerificationEmail.mock.calls[0] as unknown as [unknown, FakeRow, string, string];
    expect(hashDsrVerificationToken(args[2])).toBe(stored?.verification_token_hash);
    expect(args[3]).toBe(SITE);
    if (result.ok) {
      expect(result.data.verification_send_count).toBe(3);
      expect(result.data).not.toHaveProperty('verification_token_hash');
    }
  });

  it('期限切れでも再送できる (期限切れかどうかは問わない)', async () => {
    const row = seedPending({ verification_expires_at: iso(-MS_PER_DAY) });
    expect((await resend(row.id)).ok).toBe(true);
    expect(db.find(row.id)?.verification_expires_at).toBe(iso(24 * MS_PER_HOUR));
  });

  it(`送信回数が上限 (${DSR_VERIFICATION_MAX_SENDS}) なら 409 DSR_VERIFICATION_LIMIT。上限の 1 つ手前は送れる`, async () => {
    const atLimit = seedPending({ verification_send_count: DSR_VERIFICATION_MAX_SENDS });
    expect(await resend(atLimit.id)).toEqual({ ok: false, status: 409, code: 'DSR_VERIFICATION_LIMIT' });
    expect(db.callsOf('update')).toHaveLength(0);
    expectNoEmails();

    const below = seedPending({ verification_send_count: DSR_VERIFICATION_MAX_SENDS - 1, request_type: 'erasure' });
    expect((await resend(below.id)).ok).toBe(true);
    expect(db.find(below.id)?.verification_send_count).toBe(DSR_VERIFICATION_MAX_SENDS);
  });

  it.each(['received', 'in_progress', 'fulfilled', 'rejected', 'withdrawn'] as const)(
    '%s は 409 DSR_INVALID_STATE (回数の上限より先に判定。書き込みもメールも無し)',
    async (status) => {
      const row = seedVerified(status, { verification_send_count: DSR_VERIFICATION_MAX_SENDS });
      expect(await resend(row.id)).toEqual({ ok: false, status: 409, code: 'DSR_INVALID_STATE' });
      expect(db.callsOf('update')).toHaveLength(0);
      expectNoEmails();
    },
  );

  it('他人の行は 404', async () => {
    const row = seedPending({ user_id: OTHER });
    expect(await resend(row.id)).toEqual({ ok: false, status: 404, code: 'NOT_FOUND' });
    expectNoEmails();
  });

  it('判定の後に別のタブで確認が済んだ・再送された → UPDATE が 0 行 → 409 DSR_INVALID_STATE・メールを送らない', async () => {
    const verified = seedPending();
    db.beforeUpdate = () => {
      Object.assign(db.find(verified.id) ?? {}, {
        status: 'received',
        verified_at: NOW.toISOString(),
        due_at: iso(MS_PER_DAY),
        verification_token_hash: null,
      });
    };
    expect(await resend(verified.id)).toEqual({ ok: false, status: 409, code: 'DSR_INVALID_STATE' });
    expect(db.find(verified.id)?.status).toBe('received');

    const resent = seedPending({ request_type: 'erasure' });
    db.beforeUpdate = () => {
      Object.assign(db.find(resent.id) ?? {}, { verification_send_count: 2 });
    };
    expect(await resend(resent.id)).toEqual({ ok: false, status: 409, code: 'DSR_INVALID_STATE' });
    expect(db.find(resent.id)?.verification_send_count).toBe(2);
    expectNoEmails();
  });

  it('DB の失敗は 500 (メールを送らない)', async () => {
    const row = seedPending();
    db.failNext.update = { code: 'XX000', message: 'x' };
    expect(await resend(row.id)).toMatchObject({ ok: false, status: 500, code: 'INTERNAL_ERROR' });
    expectNoEmails();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 取り下げ
// ─────────────────────────────────────────────────────────────────────────────

describe('withdrawDsr', () => {
  const withdraw = (id: unknown, userId = ME) => withdrawDsr(admin(), { userId, id: String(id) }, ctx);

  it.each(['pending_verification', 'received', 'in_progress'] as const)(
    '%s → withdrawn (resolved_at = now・hash = NULL)。メールは送らない',
    async (status) => {
      const row =
        status === 'pending_verification' ? seedPending() : seedVerified(status);
      const result = await withdraw(row.id);
      expect(result.ok).toBe(true);
      expect(db.find(row.id)).toMatchObject({ status: 'withdrawn', resolved_at: NOW.toISOString(), verification_token_hash: null });
      const [update] = db.callsOf('update', 'admin');
      expect(update.filters).toEqual([
        { kind: 'eq', column: 'id', value: row.id },
        { kind: 'eq', column: 'user_id', value: ME },
        { kind: 'in', column: 'status', value: [...DSR_OPEN_STATUSES] },
      ]);
      expect(update.columns).toBe(DSR_OWN_COLUMNS);
      if (result.ok) expect(result.data.status).toBe('withdrawn');
      expectNoEmails();
    },
  );

  it.each(['fulfilled', 'rejected', 'withdrawn'] as const)('%s は 409 DSR_INVALID_STATE (書き込み無し)', async (status) => {
    const row = seedVerified(status);
    expect(await withdraw(row.id)).toEqual({ ok: false, status: 409, code: 'DSR_INVALID_STATE' });
    expect(db.callsOf('update')).toHaveLength(0);
  });

  it('判定の後に運営が対応済みにした → UPDATE が 0 行 → 409 DSR_INVALID_STATE (対応済みの記録を上書きしない)', async () => {
    const row = seedVerified('in_progress');
    db.beforeUpdate = () => {
      Object.assign(db.find(row.id) ?? {}, { status: 'fulfilled', resolved_at: iso(-1), response_note: '運営の応答' });
    };
    expect(await withdraw(row.id)).toEqual({ ok: false, status: 409, code: 'DSR_INVALID_STATE' });
    expect(db.find(row.id)).toMatchObject({ status: 'fulfilled', response_note: '運営の応答', resolved_at: iso(-1) });
  });

  it('他人の行は 404・DB の失敗は 500', async () => {
    const others = seedVerified('received', { user_id: OTHER });
    expect(await withdraw(others.id)).toEqual({ ok: false, status: 404, code: 'NOT_FOUND' });
    expect(db.find(others.id)?.status).toBe('received');
    const mine = seedVerified('received');
    db.failNext.update = { code: 'XX000', message: 'x' };
    expect(await withdraw(mine.id)).toMatchObject({ ok: false, status: 500, code: 'INTERNAL_ERROR' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 運営の一覧・詳細
// ─────────────────────────────────────────────────────────────────────────────

describe('listDsrForOperator', () => {
  const list = (query = {}, page = 1, perPage = 50) => listDsrForOperator(user(), { query, page, perPage }, ctx);

  it('本人のセッションの client で DSR_ADMIN_LIST_COLUMNS を件数つきで読む。並びは due_at 昇順 (NULL は最後) → created_at 降順 → id 降順', async () => {
    const pending = seedPending();
    const later = seedVerified('received', { user_id: OTHER, due_at: iso(10 * MS_PER_DAY) });
    const sooner = seedVerified('in_progress', { due_at: iso(MS_PER_DAY), request_type: 'erasure' });
    fetchNicknamesMock.mockResolvedValue(new Map([[OTHER, 'ほかのひと']]));

    const result = await list();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows.map((r) => r.id)).toEqual([sooner.id, later.id, pending.id]);
    expect(result.data.total).toBe(3);
    expect(result.data.rows[1]).toMatchObject({ requester_nickname: 'ほかのひと', overdue: false });
    expect(result.data.rows[0].requester_nickname).toBeNull();
    const [call] = db.callsOf('select', 'user');
    expect(call.columns).toBe(DSR_ADMIN_LIST_COLUMNS);
    expect(call.count).toBe(true);
    expect(call.orders).toEqual([
      { column: 'due_at', ascending: true, nullsFirst: false },
      { column: 'created_at', ascending: false, nullsFirst: undefined },
      { column: 'id', ascending: false, nullsFirst: undefined },
    ]);
    expect(call.range).toEqual([0, 49]);
    expect(db.callsOf('select', 'admin')).toHaveLength(0);
    expect(fetchNicknamesMock).toHaveBeenCalledWith([sooner.user_id, later.user_id, pending.user_id], ctx.log);
    for (const row of result.data.rows) {
      expect(row).not.toHaveProperty('admin_notes');
      expect(row).not.toHaveProperty('details');
    }
  });

  it('status / request_type で絞る', async () => {
    seedVerified('received');
    const target = seedVerified('in_progress', { request_type: 'correction', user_id: OTHER });
    seedVerified('in_progress', { request_type: 'erasure' });

    const result = await list({ status: 'in_progress', request_type: 'correction' });

    expect(result.ok && result.data.rows.map((r) => r.id)).toEqual([target.id]);
    const [call] = db.callsOf('select', 'user');
    expect(call.filters).toEqual([
      { kind: 'eq', column: 'status', value: 'in_progress' },
      { kind: 'eq', column: 'request_type', value: 'correction' },
    ]);
  });

  it('overdue=1 は received / in_progress かつ due_at < now だけ (終わった請求・期限内・本人確認待ちは出ない)', async () => {
    const overdueReceived = seedVerified('received', { due_at: iso(-MS_PER_DAY) });
    const overdueInProgress = seedVerified('in_progress', { due_at: iso(-1), user_id: OTHER });
    seedVerified('fulfilled', { due_at: iso(-MS_PER_DAY), request_type: 'erasure' });
    seedVerified('received', { due_at: iso(MS_PER_DAY), request_type: 'correction' });
    seedVerified('received', { due_at: NOW.toISOString(), request_type: 'suspension' });
    seedPending({ request_type: 'erasure', user_id: OTHER });

    const result = await list({ overdue: '1' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows.map((r) => r.id).sort()).toEqual([overdueReceived.id, overdueInProgress.id].sort());
    expect(result.data.rows.every((r) => r.overdue)).toBe(true);
    const [call] = db.callsOf('select', 'user');
    expect(call.filters).toEqual([
      { kind: 'in', column: 'status', value: ['received', 'in_progress'] },
      { kind: 'lt', column: 'due_at', value: NOW.toISOString() },
    ]);
  });

  it('status と overdue を同時に指定したら両方で絞る', async () => {
    seedVerified('received', { due_at: iso(-MS_PER_DAY) });
    const target = seedVerified('in_progress', { due_at: iso(-MS_PER_DAY), user_id: OTHER });
    const result = await list({ status: 'in_progress', overdue: '1' });
    expect(result.ok && result.data.rows.map((r) => r.id)).toEqual([target.id]);
  });

  it('ページ: page と perPage から range を作る。件数より後ろのページ (416) は空のページ (total: null)', async () => {
    for (let i = 0; i < 3; i++) seedVerified('received', { user_id: `00000000-0000-4000-8000-00000000000${i}` });
    const second = await list({}, 2, 2);
    expect(second.ok && second.data.rows).toHaveLength(1);
    expect(second.ok && second.data.total).toBe(3);
    expect(db.callsOf('select', 'user')[0].range).toEqual([2, 3]);

    const beyond = await list({}, 5, 2);
    expect(beyond).toEqual({ ok: true, data: { rows: [], total: null } });
  });

  it('416 以外の DB の失敗は 500', async () => {
    db.failNext.select = { code: 'XX000', message: 'x', status: 500 };
    expect(await list()).toMatchObject({ ok: false, status: 500, code: 'INTERNAL_ERROR' });
  });

  it('PGRST103 のコードだけ (ステータスが 416 でない) でも空のページ', async () => {
    db.failNext.select = { code: 'PGRST103', message: 'range', status: 400 };
    expect(await list({}, 3, 2)).toEqual({ ok: true, data: { rows: [], total: null } });
  });
});

describe('getDsrForOperator', () => {
  it('service_role の client で DSR_ADMIN_COLUMNS を読み、admin_notes と請求者 (ニックネーム・メールアドレス) を返す', async () => {
    const row = seedVerified('in_progress', { admin_notes: '内部メモ', details: '内容' });
    fetchNicknamesMock.mockResolvedValue(new Map([[ME, 'たろう']]));
    fetchUserEmailsMock.mockResolvedValue(new Map([[ME, 'taro@example.com']]));

    const result = await getDsrForOperator(admin(), String(row.id), ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      id: row.id,
      admin_notes: '内部メモ',
      details: '内容',
      requester_nickname: 'たろう',
      requester: { user_id: ME, nickname: 'たろう', email: 'taro@example.com' },
    });
    expect(result.data).not.toHaveProperty('verification_token_hash');
    const [call] = db.callsOf('select', 'admin');
    expect(call.columns).toBe(DSR_ADMIN_COLUMNS);
    expect(call.filters).toEqual([{ kind: 'eq', column: 'id', value: row.id }]);
    expect(db.callsOf('select', 'user')).toHaveLength(0);
    expect(fetchUserEmailsMock).toHaveBeenCalledWith(expect.anything(), [ME], 'GET /api/admin/data-requests/[id]');
    expect(fetchNicknamesMock).toHaveBeenCalledWith([ME], ctx.log);
  });

  it('ニックネーム・メールアドレスが引けなければ null', async () => {
    const row = seedVerified('received');
    const result = await getDsrForOperator(admin(), String(row.id), ctx);
    expect(result.ok && result.data.requester).toEqual({ user_id: ME, nickname: null, email: null });
  });

  it('退会済み (user_id が NULL) は requester = null で、ニックネームもメールアドレスも引かない', async () => {
    const row = seedVerified('received', { user_id: null });
    const result = await getDsrForOperator(admin(), String(row.id), ctx);
    expect(result.ok && result.data.requester).toBeNull();
    expect(fetchNicknamesMock).not.toHaveBeenCalled();
    expect(fetchUserEmailsMock).not.toHaveBeenCalled();
  });

  it('無い行は 404・DB の失敗は 500', async () => {
    expect(await getDsrForOperator(admin(), '33333333-3333-4333-8333-333333333333', ctx)).toEqual({
      ok: false,
      status: 404,
      code: 'NOT_FOUND',
    });
    db.failNext.select = { code: 'XX000', message: 'x' };
    expect(await getDsrForOperator(admin(), '33333333-3333-4333-8333-333333333333', ctx)).toMatchObject({
      ok: false,
      status: 500,
      code: 'INTERNAL_ERROR',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 運営の更新
// ─────────────────────────────────────────────────────────────────────────────

describe('updateDsrByOperator', () => {
  const update = (row: FakeRow, input: Record<string, unknown>, header: string | null = String(row.updated_at)) =>
    updateDsrByOperator(admin(), { id: String(row.id), ifUnmodifiedSince: header, input }, ctx);

  it('If-Unmodified-Since が無い・空白だけなら 428 (行を読まない)', async () => {
    const row = seedVerified('received');
    expect(await update(row, { status: 'in_progress' }, null)).toEqual({
      ok: false,
      status: 428,
      code: 'CONFLICT_PRECONDITION_REQUIRED',
    });
    expect(await update(row, { status: 'in_progress' }, '  ')).toMatchObject({ status: 428 });
    expect(db.calls).toHaveLength(0);
  });

  it('行が無ければ 404', async () => {
    const ghost = { id: '33333333-3333-4333-8333-333333333333', updated_at: NOW.toISOString() };
    expect(await update(ghost, { status: 'in_progress' })).toEqual({ ok: false, status: 404, code: 'NOT_FOUND' });
  });

  it('updated_at がヘッダと違えば 412 (書き込み無し)', async () => {
    const row = seedVerified('received');
    expect(await update(row, { status: 'in_progress' }, '2020-01-01T00:00:00.000Z')).toEqual({
      ok: false,
      status: 412,
      code: 'CONFLICT_OPTIMISTIC_LOCK',
    });
    expect(db.callsOf('update')).toHaveLength(0);
  });

  it('received → in_progress: service_role で読み直し、id と updated_at を条件に書く。メールは送らない', async () => {
    const row = seedVerified('received');
    const before = { ...row };

    const result = await update(row, { status: 'in_progress' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.before).toMatchObject({ status: 'received', updated_at: before.updated_at });
    expect(result.data.after).toMatchObject({ status: 'in_progress', resolved_at: null });
    expect(result.data.after.updated_at).not.toBe(before.updated_at);
    expect(result.data.changed).toEqual({ status: true, response_note: false, admin_notes: false });
    const [read] = db.callsOf('select', 'admin');
    expect(read.columns).toBe(DSR_ADMIN_COLUMNS);
    const [write] = db.callsOf('update', 'admin');
    expect(write.payload).toEqual({ status: 'in_progress' });
    expect(write.filters).toEqual([
      { kind: 'eq', column: 'id', value: row.id },
      { kind: 'eq', column: 'updated_at', value: before.updated_at },
    ]);
    expect(write.columns).toBe(DSR_ADMIN_COLUMNS);
    expect(db.callsOf('select', 'user')).toHaveLength(0);
    expectNoEmails();
  });

  it.each([
    ['received', 'fulfilled'],
    ['received', 'rejected'],
    ['in_progress', 'fulfilled'],
    ['in_progress', 'rejected'],
  ] as const)('%s → %s (応答あり): resolved_at = now・完了のメール', async (from, to) => {
    const row = seedVerified(from);
    const result = await update(row, { status: to, response_note: '対応しました' });
    expect(result.ok).toBe(true);
    expect(db.find(row.id)).toMatchObject({ status: to, response_note: '対応しました', resolved_at: NOW.toISOString() });
    expect(notifications.sendDsrResolvedEmail).toHaveBeenCalledTimes(1);
    const args = notifications.sendDsrResolvedEmail.mock.calls[0] as unknown as [unknown, FakeRow, string, unknown];
    expect(args[1]).toMatchObject({ id: row.id, status: to });
    expect(args[2]).toBe(SITE);
    expect(args[3]).toBe(ctx.log);
  });

  it('すでに書いてある応答があれば、status だけで fulfilled にできる', async () => {
    const row = seedVerified('in_progress', { response_note: '先に書いた応答' });
    const result = await update(row, { status: 'fulfilled' });
    expect(result.ok).toBe(true);
    expect(db.find(row.id)).toMatchObject({ status: 'fulfilled', response_note: '先に書いた応答' });
  });

  it.each(['fulfilled', 'rejected'] as const)('%s で更新後の応答が空なら 422 (書き込みもメールも無し)', async (to) => {
    const row = seedVerified('in_progress');
    expect(await update(row, { status: to })).toEqual({ ok: false, status: 422, code: 'DSR_RESPONSE_NOTE_REQUIRED' });
    expect(await update(row, { status: to, response_note: '   ' })).toMatchObject({ status: 422 });
    expect(await update(row, { status: to, response_note: null })).toMatchObject({ status: 422 });
    const withNote = seedVerified('received', { response_note: '既存の応答', request_type: 'erasure' });
    expect(await update(withNote, { status: to, response_note: '' })).toMatchObject({ status: 422 });
    expect(db.callsOf('update')).toHaveLength(0);
    expectNoEmails();
  });

  it('in_progress → in_progress (同じ状態の指定) は 409 DSR_INVALID_TRANSITION', async () => {
    const row = seedVerified('in_progress');
    expect(await update(row, { status: 'in_progress', response_note: 'x' })).toEqual({
      ok: false,
      status: 409,
      code: 'DSR_INVALID_TRANSITION',
    });
    expect(db.callsOf('update')).toHaveLength(0);
  });

  it.each(['pending_verification', 'fulfilled', 'rejected', 'withdrawn'] as const)(
    '%s は status の有無を問わず 409 DSR_INVALID_TRANSITION (応答・内部メモだけの更新も。書き込みもメールも無し)',
    async (status) => {
      const row = status === 'pending_verification' ? seedPending() : seedVerified(status);
      for (const input of [
        { status: 'in_progress' },
        { status: 'fulfilled', response_note: '応答' },
        { response_note: '書き換え' },
        { admin_notes: 'メモ' },
      ]) {
        expect(await update(row, input), JSON.stringify(input)).toEqual({
          ok: false,
          status: 409,
          code: 'DSR_INVALID_TRANSITION',
        });
      }
      expect(db.callsOf('update')).toHaveLength(0);
      expectNoEmails();
    },
  );

  it('status 無しで応答・内部メモだけを直す (received・in_progress)。状態は変えず、メールも送らない', async () => {
    for (const status of ['received', 'in_progress'] as const) {
      const row = seedVerified(status, { request_type: status === 'received' ? 'disclosure' : 'erasure' });
      const result = await update(row, { response_note: '途中の応答', admin_notes: '確認中' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.changed).toEqual({ status: false, response_note: true, admin_notes: true });
      expect(db.find(row.id)).toMatchObject({ status, response_note: '途中の応答', admin_notes: '確認中', resolved_at: null });
    }
    const writes = db.callsOf('update');
    expect(writes.map((w) => w.payload)).toEqual([
      { response_note: '途中の応答', admin_notes: '確認中' },
      { response_note: '途中の応答', admin_notes: '確認中' },
    ]);
    expectNoEmails();
  });

  it('空白だけの応答・内部メモは null として保存し、null を送ると消せる', async () => {
    const row = seedVerified('in_progress', { response_note: '古い応答', admin_notes: '古いメモ' });
    const result = await update(row, { response_note: '  ', admin_notes: null });
    expect(result.ok).toBe(true);
    expect(db.find(row.id)).toMatchObject({ response_note: null, admin_notes: null });
  });

  it('変更が無ければ書き込まない (updated_at を動かさない)。before と after は同じ行', async () => {
    const row = seedVerified('in_progress', { response_note: '応答', admin_notes: 'メモ' });
    const updatedAt = row.updated_at;
    const result = await update(row, { response_note: '応答', admin_notes: 'メモ' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.changed).toEqual({ status: false, response_note: false, admin_notes: false });
      expect(result.data.after).toEqual(result.data.before);
    }
    expect(db.callsOf('update')).toHaveLength(0);
    expect(db.find(row.id)?.updated_at).toBe(updatedAt);
  });

  it('片方だけ指定したら、もう片方は今の値のまま (書く項目にも入れない)', async () => {
    const row = seedVerified('received', { response_note: '応答', admin_notes: 'メモ' });
    await update(row, { admin_notes: '新しいメモ' });
    expect(db.callsOf('update')[0].payload).toEqual({ admin_notes: '新しいメモ' });
    expect(db.find(row.id)).toMatchObject({ response_note: '応答', admin_notes: '新しいメモ' });
  });

  it('読み直しと UPDATE の間に別の運営者が更新した → UPDATE が 0 行 → 409 CONFLICT_STALE_DATA (メール無し)', async () => {
    const row = seedVerified('in_progress');
    db.beforeUpdate = () => {
      Object.assign(db.find(row.id) ?? {}, { admin_notes: '別の運営者', updated_at: iso(1) });
    };
    expect(await update(row, { status: 'fulfilled', response_note: '応答' })).toEqual({
      ok: false,
      status: 409,
      code: 'CONFLICT_STALE_DATA',
    });
    expect(db.find(row.id)).toMatchObject({ status: 'in_progress', admin_notes: '別の運営者' });
    expectNoEmails();
  });

  it('退会済み (user_id が NULL) の received も fulfilled にでき、完了のメールの関数に行を渡す (送らない判断は notifications)', async () => {
    const row = seedVerified('received', { user_id: null });
    const result = await update(row, { status: 'fulfilled', response_note: '退会で完了' });
    expect(result.ok).toBe(true);
    expect(notifications.sendDsrResolvedEmail).toHaveBeenCalledTimes(1);
    const args = notifications.sendDsrResolvedEmail.mock.calls[0] as unknown as [unknown, FakeRow];
    expect(args[1]).toMatchObject({ user_id: null, status: 'fulfilled' });
  });

  it('読み取り・書き込みの DB の失敗は 500', async () => {
    const row = seedVerified('received');
    db.failNext.select = { code: 'XX000', message: 'x' };
    expect(await update(row, { status: 'in_progress' })).toMatchObject({ ok: false, status: 500, code: 'INTERNAL_ERROR' });
    db.failNext.update = { code: 'XX000', message: 'x' };
    expect(await update(row, { status: 'in_progress' })).toMatchObject({ ok: false, status: 500, code: 'INTERNAL_ERROR' });
    expect(db.find(row.id)?.status).toBe('received');
  });

  it('運営が作れる状態は in_progress / fulfilled / rejected だけ (表に無い遷移を作らない)', async () => {
    const reachable = new Set<DsrStatus>();
    for (const from of ['received', 'in_progress'] as const) {
      for (const to of DSR_STATUSES) {
        const row = seedVerified(from, { request_type: 'disclosure', user_id: `${from}-${to}` });
        const result = await update(row, { status: to, response_note: '応答' });
        if (result.ok) reachable.add(to);
      }
    }
    expect([...reachable].sort()).toEqual(['fulfilled', 'in_progress', 'rejected']);
  });
});

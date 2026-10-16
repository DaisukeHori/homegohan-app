import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LEGAL_DOCUMENTS, PUSH_NOTIFICATION_KIND_SPECS } from '@homegohan/shared';
import {
  EXPO_DEVICE_NOT_REGISTERED,
  EXPO_PUSH_RECEIPT_CHUNK_SIZE,
  EXPO_PUSH_SEND_CHUNK_SIZE,
  PUSH_OUTBOX_BATCH_SIZE,
  PUSH_OUTBOX_ERROR_CODES,
  PUSH_OUTBOX_LEASE_SECONDS,
  PUSH_OUTBOX_MAX_ATTEMPTS,
  PUSH_OUTBOX_QUEUED_MAX_AGE_MS,
  PUSH_OUTBOX_RUN_BUDGET_MS,
  PUSH_QUIET_HOURS_DEFAULT_END_MINUTES,
  PUSH_QUIET_HOURS_DEFAULT_START_MINUTES,
  PUSH_QUIET_HOURS_UTC_OFFSET_MINUTES,
  PUSH_RECEIPT_CHECK_DELAY_SECONDS,
  PUSH_RECEIPT_MAX_AGE_SECONDS,
  decideEligibility,
  isRequestLevelRejection,
  isWithinQuietHours,
  localMinutesOfDay,
  maskPushToken,
  parseClockMinutes,
  processPushOutbox,
  quietHoursEndMs,
  resolvePushOutboxSettings,
  retryDelaySeconds,
  type ExpoPushReceipt,
  type ExpoPushTicket,
  type PushKindPolicy,
  type PushMessage,
  type PushOutboxClaimedRow,
  type PushOutboxFailInput,
  type PushOutboxReceiptRow,
  type PushOutboxRunOptions,
  type PushOutboxStore,
  type PushOutboxWorkerDeps,
  type PushReceiptsOutcome,
  type PushSendOutcome,
  type PushTransportFailure,
  type PushUserEligibility,
} from '@/lib/push/outbox';
import { renderPushMessage } from '@/lib/push/render';

// #1136 Push 通知の送信待ちの worker の本体 (src/lib/push/outbox.ts)。DB (store)・Expo (transport)・時計・ログは作り物にし、
// 送る条件・夜間・塊の分け方・ticket と receipt の扱いを確かめる。値はすべてテスト用のダミー (本物の token は使わない)。
// 設計: docs/design/mobile/06-push-send.md §6.3・§7.1・§9・§10

const ROOT = path.resolve(__dirname, '../../../..');

/** 昼 (2026-10-16 12:00 JST = 03:00 UTC)。夜間 (22:00〜07:00 JST) の外 */
const NOON_JST = Date.parse('2026-10-16T03:00:00.000Z');
/** 夜 (2026-10-16 23:30 JST = 14:30 UTC) */
const NIGHT_JST = Date.parse('2026-10-16T14:30:00.000Z');
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
/** 夜間の延期だけをする種類 (第 1 段の種類はどれも send なので、テストのために足す) */
const DEFER_KIND = 'test_defer_kind';
const START_DATE = '2026-10-20';

const uuidOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tokenOf = (n: number) => `ExponentPushToken[dummy${String(n).padStart(6, '0')}]`;
const USER_ID = uuidOf(900_001);

function makeRow(n: number, overrides: Partial<PushOutboxClaimedRow> = {}): PushOutboxClaimedRow {
  return {
    id: uuidOf(n),
    user_id: USER_ID,
    push_token_id: uuidOf(500_000 + n),
    expo_push_token: tokenOf(n),
    kind: 'weekly_menu_completed',
    payload: { request_id: uuidOf(700_000 + n), start_date: START_DATE, mode: 'v5' },
    attempts: 0,
    created_at: new Date(NOON_JST - 5 * MS_PER_MINUTE).toISOString(),
    ...overrides,
  };
}
const makeRows = (count: number, overrides: Partial<PushOutboxClaimedRow> = {}) =>
  Array.from({ length: count }, (_, index) => makeRow(index + 1, overrides));

function makeUser(overrides: Partial<PushUserEligibility> = {}): PushUserEligibility {
  return {
    frozenAt: null,
    unbanAt: null,
    termsVersionAccepted: LEGAL_DOCUMENTS.terms_of_service.version,
    privacyVersionAccepted: LEGAL_DOCUMENTS.privacy_policy.version,
    notificationsEnabled: true,
    quietHoursStart: null,
    quietHoursEnd: null,
    ...overrides,
  };
}

function makeReceiptRow(n: number, overrides: Partial<PushOutboxReceiptRow> = {}): PushOutboxReceiptRow {
  return {
    id: uuidOf(n),
    user_id: USER_ID,
    push_token_id: uuidOf(500_000 + n),
    expo_push_token: tokenOf(n),
    receipt_id: `receipt-${n}`,
    sent_at: new Date(NOON_JST - 20 * MS_PER_MINUTE).toISOString(),
    ...overrides,
  };
}

const okTickets = (messages: readonly PushMessage[]): ExpoPushTicket[] =>
  messages.map((message) => ({ status: 'ok', id: `ticket-${message.to}` }));

interface HarnessInput {
  rows?: PushOutboxClaimedRow[];
  users?: Map<string, PushUserEligibility>;
  receiptRows?: PushOutboxReceiptRow[];
  send?: (messages: readonly PushMessage[]) => Promise<PushSendOutcome>;
  getReceipts?: (ids: readonly string[]) => Promise<PushReceiptsOutcome>;
  now?: number;
  cleanup?: { expired: number; sent: number; dead: number };
}

/** 作り物の store / transport。fail は DB の fail_push_outbox と同じ規則で requeued / dead を返す */
function makeHarness(input: HarnessInput = {}) {
  const clock = { now: input.now ?? NOON_JST };
  const users = input.users ?? new Map([[USER_ID, makeUser()]]);
  const store = {
    claimQueued: vi.fn(async () => input.rows ?? []),
    loadEligibility: vi.fn(async () => users),
    complete: vi.fn(async () => true),
    fail: vi.fn(async (failInput: PushOutboxFailInput) => {
      const row = (input.rows ?? []).find((candidate) => candidate.id === failInput.id);
      const attempts = (row?.attempts ?? 0) + 1;
      return !failInput.retryable || attempts >= failInput.maxAttempts ? 'dead' : 'requeued';
    }),
    defer: vi.fn(async () => true),
    claimReceipts: vi.fn(async () => input.receiptRows ?? []),
    recordReceipt: vi.fn(async () => true),
    deleteToken: vi.fn(async () => true),
    cleanup: vi.fn(async () => input.cleanup ?? { expired: 0, sent: 0, dead: 0 }),
  } satisfies PushOutboxStore;
  const send = vi.fn(input.send ?? (async (messages: readonly PushMessage[]) => ({ ok: true as const, tickets: okTickets(messages) })));
  const getReceipts = vi.fn(input.getReceipts ?? (async () => ({ ok: true as const, receipts: {} })));
  const info = vi.fn();
  const warn = vi.fn();
  const kinds: Record<string, PushKindPolicy | undefined> = {
    ...PUSH_NOTIFICATION_KIND_SPECS,
    [DEFER_KIND]: { path: '/home', quietHours: 'defer', ttlSeconds: 3600, priority: 'default' },
  };
  const deps: PushOutboxWorkerDeps = {
    store,
    transport: { send, getReceipts },
    kinds,
    render: (kind, payload, routePath) =>
      kind === DEFER_KIND ? { title: 'テスト', body: 'テスト', data: { kind, path: routePath } } : renderPushMessage(kind, payload, routePath),
    now: () => clock.now,
    log: { info, warn },
  };
  return { deps, store, send, getReceipts, info, warn, clock };
}

type Harness = ReturnType<typeof makeHarness>;

const OPTIONS: PushOutboxRunOptions = {
  workerId: 'worker-test',
  maxAttempts: PUSH_OUTBOX_MAX_ATTEMPTS,
  batchSize: PUSH_OUTBOX_BATCH_SIZE,
  legalConsentEnforced: true,
};

const failCalls = (h: Harness) => h.store.fail.mock.calls.map(([arg]) => arg as PushOutboxFailInput);
const sentMessages = (h: Harness, call: number) => h.send.mock.calls[call]?.[0] as PushMessage[];

describe('decideEligibility (送る条件 #1136)', () => {
  it('送る条件: プロフィール無し / 24 時間超 / token の形が違う / 凍結 / 未同意 (on だけ) / 設定 off の順で dead のコードが決まる', () => {
    const fresh = makeRow(1);
    const expired = makeRow(2, { created_at: new Date(NOON_JST - PUSH_OUTBOX_QUEUED_MAX_AGE_MS - 1).toISOString() });
    const badTokenExpired = makeRow(3, { ...expired, expo_push_token: 'not-a-token' });
    const badToken = makeRow(4, { expo_push_token: 'not-a-token' });
    const frozen = makeUser({ frozenAt: '2026-10-01T00:00:00Z' });
    const frozenUnconsentedDisabled = makeUser({ frozenAt: '2026-10-01T00:00:00Z', termsVersionAccepted: null, notificationsEnabled: false });
    const unconsentedDisabled = makeUser({ termsVersionAccepted: 'v2000.0', notificationsEnabled: false });
    const disabled = makeUser({ notificationsEnabled: false });
    const on = { nowMs: NOON_JST, legalConsentEnforced: true };
    const off = { nowMs: NOON_JST, legalConsentEnforced: false };

    // 前の条件が後の条件より先に決まる
    expect(decideEligibility(expired, undefined, on)).toEqual({ ok: false, code: PUSH_OUTBOX_ERROR_CODES.PROFILE_MISSING });
    expect(decideEligibility(badTokenExpired, frozen, on)).toEqual({ ok: false, code: PUSH_OUTBOX_ERROR_CODES.EXPIRED });
    expect(decideEligibility(badToken, frozen, on)).toEqual({ ok: false, code: PUSH_OUTBOX_ERROR_CODES.INVALID_TOKEN });
    expect(decideEligibility(fresh, frozenUnconsentedDisabled, on)).toEqual({ ok: false, code: PUSH_OUTBOX_ERROR_CODES.ACCOUNT_FROZEN });
    expect(decideEligibility(fresh, unconsentedDisabled, on)).toEqual({ ok: false, code: PUSH_OUTBOX_ERROR_CODES.CONSENT_OUTDATED });
    // 同意の強制が off なら、未同意は見ずに次の条件 (設定 off) へ
    expect(decideEligibility(fresh, unconsentedDisabled, off)).toEqual({ ok: false, code: PUSH_OUTBOX_ERROR_CODES.NOTIFICATIONS_DISABLED });
    expect(decideEligibility(fresh, makeUser({ termsVersionAccepted: null }), off)).toEqual({ ok: true });
    expect(decideEligibility(fresh, disabled, on)).toEqual({ ok: false, code: PUSH_OUTBOX_ERROR_CODES.NOTIFICATIONS_DISABLED });
    expect(decideEligibility(fresh, makeUser(), on)).toEqual({ ok: true });
    // 一時 BAN の期限が過ぎていれば凍結ではない
    expect(decideEligibility(fresh, makeUser({ frozenAt: '2026-01-01T00:00:00Z', unbanAt: '2026-02-01T00:00:00Z' }), on)).toEqual({ ok: true });
    // ちょうど 24 時間は期限内
    const boundary = makeRow(5, { created_at: new Date(NOON_JST - PUSH_OUTBOX_QUEUED_MAX_AGE_MS).toISOString() });
    expect(decideEligibility(boundary, makeUser(), on)).toEqual({ ok: true });
  });
});

describe('processPushOutbox: 送る前に弾く行と、要求ごとの拒否 (#1136 R-24)', () => {
  it('token の形が違う行 (isExpoPushToken が false) は Expo に渡さず invalid_token で dead にし、端末の行を消さず、同じ回のほかの行は送る (S-23)', async () => {
    const rows = [makeRow(1), makeRow(2, { expo_push_token: 'ExponentPushToken[]' }), makeRow(3)];
    const h = makeHarness({ rows });

    const summary = await processPushOutbox(h.deps, OPTIONS);

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(sentMessages(h, 0).map((message) => message.to)).toEqual([tokenOf(1), tokenOf(3)]);
    expect(failCalls(h)).toEqual([
      expect.objectContaining({ id: uuidOf(2), errorCode: PUSH_OUTBOX_ERROR_CODES.INVALID_TOKEN, retryable: false, statusCode: null }),
    ]);
    expect(h.store.deleteToken).not.toHaveBeenCalled();
    expect(h.store.complete.mock.calls.map(([id]) => id)).toEqual([uuidOf(1), uuidOf(3)]);
    expect(summary).toMatchObject({ claimed: 3, sent: 2, dead: 1, dead_codes: { invalid_token: 1 }, tokens_removed: 0 });
  });

  it('要求ごと 4xx (429 以外) で拒まれた 2 件以上の塊は 1 件ずつ送り直し、原因の 1 件だけが dead でほかは sent (S-24)', async () => {
    const rows = makeRows(3);
    const rejected: PushTransportFailure = { code: 'PUSH_TOO_MANY_EXPERIENCE_IDS', message: 'mixed', statusCode: 400, retryable: false };
    const h = makeHarness({
      rows,
      send: async (messages) => {
        if (messages.length > 1) return { ok: false, failure: rejected };
        if (messages[0]?.to === tokenOf(2)) return { ok: false, failure: { ...rejected, code: 'BAD_REQUEST' } };
        return { ok: true, tickets: okTickets(messages) };
      },
    });

    const summary = await processPushOutbox(h.deps, OPTIONS);

    expect(h.send.mock.calls.map(([messages]) => (messages as PushMessage[]).length)).toEqual([3, 1, 1, 1]);
    expect(failCalls(h)).toEqual([expect.objectContaining({ id: uuidOf(2), errorCode: 'BAD_REQUEST', statusCode: 400, retryable: false })]);
    expect(h.store.complete.mock.calls.map(([id]) => id)).toEqual([uuidOf(1), uuidOf(3)]);
    expect(summary).toMatchObject({ sent: 2, dead: 1, requeued: 0, dead_codes: { BAD_REQUEST: 1 }, stopped_early: null });
    expect(h.warn).toHaveBeenCalledWith('Expo が要求ごと拒んだため、1 件ずつ送り直します', {
      error_code: 'PUSH_TOO_MANY_EXPERIENCE_IDS',
      status_code: 400,
      count: 3,
    });
  });

  it('1 件ずつの送り直しの途中の 429 でその回をやめ、残りの行は Expo に渡さず fail も呼ばない', async () => {
    const rows = makeRows(3);
    const h = makeHarness({
      rows,
      send: async (messages) => {
        if (messages.length > 1) return { ok: false, failure: { code: 'UNAUTHORIZED', message: 'x', statusCode: 401, retryable: false } };
        if (messages[0]?.to === tokenOf(2)) {
          return { ok: false, failure: { code: 'TOO_MANY_REQUESTS', message: 'x', statusCode: 429, retryable: true } };
        }
        return { ok: true, tickets: okTickets(messages) };
      },
    });

    const summary = await processPushOutbox(h.deps, OPTIONS);

    expect(h.send).toHaveBeenCalledTimes(3);
    expect(sentMessages(h, 2).map((message) => message.to)).toEqual([tokenOf(2)]);
    expect(failCalls(h)).toEqual([expect.objectContaining({ id: uuidOf(2), retryable: true, statusCode: 429 })]);
    expect(h.store.complete.mock.calls.map(([id]) => id)).toEqual([uuidOf(1)]);
    expect(summary).toMatchObject({ sent: 1, requeued: 1, dead: 0, stopped_early: 'rate_limited' });
    // 打ち切っても receipt の確認と掃除はする
    expect(h.store.claimReceipts).toHaveBeenCalledTimes(1);
    expect(h.store.cleanup).toHaveBeenCalledTimes(1);
  });

  it('応答の形の誤り (invalid_response) の塊は分けて送り直さず全行を dead にする', async () => {
    const rows = makeRows(2);
    const h = makeHarness({
      rows,
      send: async () => ({
        ok: false,
        failure: { code: PUSH_OUTBOX_ERROR_CODES.INVALID_RESPONSE, message: 'x', statusCode: null, retryable: false },
      }),
    });

    const summary = await processPushOutbox(h.deps, OPTIONS);

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(failCalls(h).map((call) => [call.id, call.errorCode, call.retryable])).toEqual([
      [uuidOf(1), 'invalid_response', false],
      [uuidOf(2), 'invalid_response', false],
    ]);
    expect(summary).toMatchObject({ dead: 2, dead_codes: { invalid_response: 2 }, sent: 0 });
  });

  it('isRequestLevelRejection は 4xx (429 以外) だけ true で、429・5xx・通信エラー・invalid_response は false', () => {
    const failure = (statusCode: number | null, retryable: boolean): PushTransportFailure => ({ code: 'x', message: 'x', statusCode, retryable });
    expect(isRequestLevelRejection(failure(400, false))).toBe(true);
    expect(isRequestLevelRejection(failure(401, false))).toBe(true);
    expect(isRequestLevelRejection(failure(413, false))).toBe(true);
    expect(isRequestLevelRejection(failure(429, true))).toBe(false);
    expect(isRequestLevelRejection(failure(500, true))).toBe(false);
    expect(isRequestLevelRejection(failure(503, true))).toBe(false);
    expect(isRequestLevelRejection(failure(null, true))).toBe(false);
    expect(isRequestLevelRejection(failure(null, false))).toBe(false);
  });
});

describe('夜間 (Quiet Hours #1136)', () => {
  it('夜間: 22:00〜07:00 をまたぐ判定と、次の 07:00 JST の時刻', () => {
    const start = PUSH_QUIET_HOURS_DEFAULT_START_MINUTES;
    const end = PUSH_QUIET_HOURS_DEFAULT_END_MINUTES;
    expect(isWithinQuietHours(21 * 60 + 59, start, end)).toBe(false);
    expect(isWithinQuietHours(22 * 60, start, end)).toBe(true);
    expect(isWithinQuietHours(0, start, end)).toBe(true);
    expect(isWithinQuietHours(6 * 60 + 59, start, end)).toBe(true);
    expect(isWithinQuietHours(7 * 60, start, end)).toBe(false);
    expect(isWithinQuietHours(12 * 60, start, end)).toBe(false);
    // 日付をまたがない形と、start = end (夜間なし)
    expect(isWithinQuietHours(13 * 60, 13 * 60, 14 * 60)).toBe(true);
    expect(isWithinQuietHours(14 * 60, 13 * 60, 14 * 60)).toBe(false);
    expect(isWithinQuietHours(5 * 60, 7 * 60, 7 * 60)).toBe(false);

    // 23:30 JST → 23 * 60 + 30。次の 07:00 JST は翌日の 22:00 UTC の前日 = 2026-10-16T22:00Z
    const nightMinutes = localMinutesOfDay(NIGHT_JST, PUSH_QUIET_HOURS_UTC_OFFSET_MINUTES);
    expect(nightMinutes).toBe(23 * 60 + 30);
    expect(new Date(quietHoursEndMs(NIGHT_JST, nightMinutes, end)).toISOString()).toBe('2026-10-16T22:00:00.000Z');
    // 03:15 JST (= 前日 18:15 UTC) → 同じ日の 07:00 JST
    const early = Date.parse('2026-10-16T18:15:30.000Z');
    const earlyMinutes = localMinutesOfDay(early, PUSH_QUIET_HOURS_UTC_OFFSET_MINUTES);
    expect(earlyMinutes).toBe(3 * 60 + 15);
    expect(new Date(quietHoursEndMs(early, earlyMinutes, end)).toISOString()).toBe('2026-10-16T22:00:00.000Z');
    expect(localMinutesOfDay(NOON_JST, PUSH_QUIET_HOURS_UTC_OFFSET_MINUTES)).toBe(12 * 60);
  });

  it('quiet_hours_start/end が null・形が違えば既定 22:00〜07:00 で夜間を判定する (parseClockMinutes の fallback)', async () => {
    const fallback = 123;
    expect(parseClockMinutes(null, fallback)).toBe(fallback);
    expect(parseClockMinutes(undefined, fallback)).toBe(fallback);
    expect(parseClockMinutes('', fallback)).toBe(fallback);
    expect(parseClockMinutes('abc', fallback)).toBe(fallback);
    expect(parseClockMinutes('7:00', fallback)).toBe(fallback);
    expect(parseClockMinutes('24:00:00', fallback)).toBe(fallback);
    expect(parseClockMinutes('23:60:00', fallback)).toBe(fallback);
    expect(parseClockMinutes('23:30:00', fallback)).toBe(23 * 60 + 30);
    expect(parseClockMinutes('06:05', fallback)).toBe(6 * 60 + 5);

    // 列が形の違う値なら既定 (22:00〜07:00) で判定し、23:30 JST は延期される
    const h = makeHarness({
      rows: [makeRow(1, { kind: DEFER_KIND, created_at: new Date(NIGHT_JST - MS_PER_MINUTE).toISOString() })],
      users: new Map([[USER_ID, makeUser({ quietHoursStart: 'garbage', quietHoursEnd: null })]]),
      now: NIGHT_JST,
    });
    const summary = await processPushOutbox(h.deps, OPTIONS);
    expect(h.store.defer).toHaveBeenCalledWith(uuidOf(1), OPTIONS.workerId, '2026-10-16T22:00:00.000Z');
    expect(summary.deferred).toBe(1);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('defer の種類だけ延期し、send の種類は夜でも送る', async () => {
    const createdAt = new Date(NIGHT_JST - MS_PER_MINUTE).toISOString();
    const rows = [makeRow(1, { kind: DEFER_KIND, created_at: createdAt }), makeRow(2, { created_at: createdAt })];
    const h = makeHarness({ rows, now: NIGHT_JST });

    const summary = await processPushOutbox(h.deps, OPTIONS);

    expect(h.store.defer).toHaveBeenCalledTimes(1);
    expect(h.store.defer).toHaveBeenCalledWith(uuidOf(1), OPTIONS.workerId, '2026-10-16T22:00:00.000Z');
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(sentMessages(h, 0).map((message) => message.to)).toEqual([tokenOf(2)]);
    expect(h.store.fail).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ deferred: 1, sent: 1, dead: 0 });

    // 利用者の夜間の時刻 (列の値) を使う: 23:00〜23:45 の外 (23:50) なら defer の種類も送る
    const late = NIGHT_JST + 20 * MS_PER_MINUTE;
    const h2 = makeHarness({
      rows: [makeRow(3, { kind: DEFER_KIND, created_at: createdAt })],
      users: new Map([[USER_ID, makeUser({ quietHoursStart: '23:00:00', quietHoursEnd: '23:45:00' })]]),
      now: late,
    });
    await processPushOutbox(h2.deps, OPTIONS);
    expect(h2.store.defer).not.toHaveBeenCalled();
    expect(h2.send).toHaveBeenCalledTimes(1);
  });
});

describe('processPushOutbox: 送信と ticket (#1136)', () => {
  it('100 件ずつ Expo に渡し、ticket を同じ順の行に対応させる', async () => {
    const total = EXPO_PUSH_SEND_CHUNK_SIZE + 50;
    const rows = makeRows(total);
    const h = makeHarness({ rows });

    const summary = await processPushOutbox(h.deps, { ...OPTIONS, batchSize: total });

    expect(h.store.claimQueued).toHaveBeenCalledWith(OPTIONS.workerId, total, PUSH_OUTBOX_LEASE_SECONDS);
    expect(h.send.mock.calls.map(([messages]) => (messages as PushMessage[]).length)).toEqual([EXPO_PUSH_SEND_CHUNK_SIZE, 50]);
    expect(sentMessages(h, 0)[0]).toEqual({
      to: tokenOf(1),
      title: '献立ができました',
      body: '10月20日からの献立ができました。開いて確認しましょう',
      data: { kind: 'weekly_menu_completed', path: '/menus', request_id: uuidOf(700_001) },
      sound: 'default',
      channelId: 'default',
      priority: 'default',
      ttl: 24 * 60 * 60,
    });
    // 行と ticket の対応: n 番目の行の complete に、n 番目のメッセージ (同じ token) の ticket の ID が渡る
    expect(h.store.complete).toHaveBeenCalledTimes(total);
    for (const n of [1, 100, 101, 150]) {
      expect(h.store.complete).toHaveBeenCalledWith(uuidOf(n), OPTIONS.workerId, `ticket-${tokenOf(n)}`);
    }
    expect(summary).toMatchObject({ claimed: total, sent: total, dead: 0 });
  });

  it('ticket error の DeviceNotRegistered で端末の行を消す', async () => {
    const rows = makeRows(2);
    const h = makeHarness({
      rows,
      send: async (messages) => ({
        ok: true,
        tickets: messages.map((message, index) =>
          index === 0
            ? { status: 'error', message: 'not registered', details: { error: EXPO_DEVICE_NOT_REGISTERED } }
            : { status: 'ok', id: `ticket-${message.to}` },
        ),
      }),
    });

    const summary = await processPushOutbox(h.deps, OPTIONS);

    expect(failCalls(h)).toEqual([
      expect.objectContaining({ id: uuidOf(1), errorCode: EXPO_DEVICE_NOT_REGISTERED, retryable: false, statusCode: null }),
    ]);
    expect(h.store.deleteToken).toHaveBeenCalledTimes(1);
    expect(h.store.deleteToken).toHaveBeenCalledWith(uuidOf(500_001));
    expect(summary).toMatchObject({ sent: 1, dead: 1, tokens_removed: 1, dead_codes: { DeviceNotRegistered: 1 } });

    // ほかの ticket error は行を dead にするだけで端末の行を消さない。details の無い error は expo_ticket_error
    const h2 = makeHarness({
      rows: makeRows(2),
      send: async () => ({
        ok: true,
        tickets: [
          { status: 'error', message: 'too big', details: { error: 'MessageTooBig' } },
          { status: 'error', message: 'unknown' },
        ],
      }),
    });
    const summary2 = await processPushOutbox(h2.deps, OPTIONS);
    expect(h2.store.deleteToken).not.toHaveBeenCalled();
    expect(summary2.dead_codes).toEqual({ MessageTooBig: 1, expo_ticket_error: 1 });
  });

  it('HTTP 429 で塊を requeue してその回を打ち切り、後続の塊は Expo に渡さず fail も呼ばない', async () => {
    const total = EXPO_PUSH_SEND_CHUNK_SIZE + 50;
    const rows = makeRows(total);
    const h = makeHarness({
      rows,
      send: async () => ({ ok: false, failure: { code: 'TOO_MANY_REQUESTS', message: 'x', statusCode: 429, retryable: true } }),
    });

    const summary = await processPushOutbox(h.deps, { ...OPTIONS, batchSize: total });

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.store.fail).toHaveBeenCalledTimes(EXPO_PUSH_SEND_CHUNK_SIZE);
    expect(failCalls(h).every((call) => call.retryable && call.statusCode === 429 && call.retryAfterSeconds === 60)).toBe(true);
    // 後続の塊 (101 件目〜) は fail も complete も呼ばない (リースのまま残す)
    expect(failCalls(h).some((call) => call.id === uuidOf(EXPO_PUSH_SEND_CHUNK_SIZE + 1))).toBe(false);
    expect(h.store.complete).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ requeued: EXPO_PUSH_SEND_CHUNK_SIZE, dead: 0, stopped_early: 'rate_limited' });
  });

  it('時間切れで残りを次の回に回す (attempts は増えない)', async () => {
    const total = EXPO_PUSH_SEND_CHUNK_SIZE + 50;
    const rows = makeRows(total);
    let clockRef: { now: number } | null = null;
    const h = makeHarness({
      rows,
      send: async (messages) => {
        // 1 つ目の要求に時間がかかり、回の開始から予算を超えた
        if (clockRef) clockRef.now += PUSH_OUTBOX_RUN_BUDGET_MS + 1;
        return { ok: true, tickets: okTickets(messages) };
      },
    });
    clockRef = h.clock;

    const summary = await processPushOutbox(h.deps, { ...OPTIONS, batchSize: total });

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.store.complete).toHaveBeenCalledTimes(EXPO_PUSH_SEND_CHUNK_SIZE);
    // 残りの 50 件は fail (attempts + 1) を呼ばない
    expect(h.store.fail).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ sent: EXPO_PUSH_SEND_CHUNK_SIZE, stopped_early: 'budget' });
    expect(h.store.claimReceipts).toHaveBeenCalledTimes(1);
    expect(h.store.cleanup).toHaveBeenCalledTimes(1);
  });

  it('24 時間を超えた queued は Expo を呼ばずに expired で dead (claim した行)', async () => {
    const rows = [makeRow(1, { created_at: new Date(NOON_JST - PUSH_OUTBOX_QUEUED_MAX_AGE_MS - MS_PER_MINUTE).toISOString() })];
    const h = makeHarness({ rows });

    const summary = await processPushOutbox(h.deps, OPTIONS);

    expect(h.send).not.toHaveBeenCalled();
    expect(failCalls(h)).toEqual([expect.objectContaining({ id: uuidOf(1), errorCode: 'expired', retryable: false })]);
    expect(summary).toMatchObject({ dead: 1, dead_codes: { expired: 1 } });
  });

  it('retryDelaySeconds は 1 回目 60・2 回目 300・3 回目以上 900 秒で、5xx の fail にその間隔を渡す (S-08)', async () => {
    expect(retryDelaySeconds(0)).toBe(60);
    expect(retryDelaySeconds(1)).toBe(60);
    expect(retryDelaySeconds(2)).toBe(300);
    expect(retryDelaySeconds(3)).toBe(900);
    expect(retryDelaySeconds(7)).toBe(900);

    const rows = [makeRow(1), makeRow(2, { attempts: 1 }), makeRow(3, { attempts: 2 })];
    const h = makeHarness({
      rows,
      send: async () => ({ ok: false, failure: { code: 'expo_http_error', message: 'x', statusCode: 503, retryable: true } }),
    });

    const summary = await processPushOutbox(h.deps, OPTIONS);

    expect(failCalls(h).map((call) => [call.id, call.retryAfterSeconds, call.maxAttempts, call.retryable])).toEqual([
      [uuidOf(1), 60, PUSH_OUTBOX_MAX_ATTEMPTS, true],
      [uuidOf(2), 300, PUSH_OUTBOX_MAX_ATTEMPTS, true],
      [uuidOf(3), 900, PUSH_OUTBOX_MAX_ATTEMPTS, true],
    ]);
    // 3 回目の失敗 (attempts 2 → 3) は dead
    expect(summary).toMatchObject({ requeued: 2, dead: 1, dead_codes: { expo_http_error: 1 } });
  });

  it('知らない種類と、形の違う payload は Expo を呼ばずに dead (unknown_kind / invalid_payload)', async () => {
    const rows = [makeRow(1, { kind: 'no_such_kind' }), makeRow(2, { payload: { request_id: 'not-a-uuid', start_date: START_DATE } })];
    const h = makeHarness({ rows });

    const summary = await processPushOutbox(h.deps, OPTIONS);

    expect(h.send).not.toHaveBeenCalled();
    expect(summary.dead_codes).toEqual({ unknown_kind: 1, invalid_payload: 1 });
  });
});

describe('processPushOutbox: receipt と掃除 (#1136)', () => {
  it('receipt: ok / error / まだ無い / 24 時間超の missing', async () => {
    const receiptRows = [
      makeReceiptRow(1),
      makeReceiptRow(2),
      makeReceiptRow(3),
      makeReceiptRow(4, { sent_at: new Date(NOON_JST - PUSH_RECEIPT_MAX_AGE_SECONDS * 1000 - MS_PER_MINUTE).toISOString() }),
    ];
    const receipts: Record<string, ExpoPushReceipt> = {
      'receipt-1': { status: 'ok' },
      'receipt-2': { status: 'error', message: 'too big', details: { error: 'MessageTooBig' } },
    };
    const h = makeHarness({ receiptRows, getReceipts: async () => ({ ok: true, receipts }) });

    const summary = await processPushOutbox(h.deps, OPTIONS);

    expect(h.store.claimReceipts).toHaveBeenCalledWith(
      OPTIONS.workerId,
      EXPO_PUSH_RECEIPT_CHUNK_SIZE,
      PUSH_RECEIPT_CHECK_DELAY_SECONDS,
      PUSH_OUTBOX_LEASE_SECONDS,
    );
    expect(h.getReceipts).toHaveBeenCalledWith(['receipt-1', 'receipt-2', 'receipt-3', 'receipt-4']);
    expect(h.store.recordReceipt.mock.calls).toEqual([
      [uuidOf(1), OPTIONS.workerId, 'ok', null],
      [uuidOf(2), OPTIONS.workerId, 'error', 'MessageTooBig'],
      [uuidOf(3), OPTIONS.workerId, null, null],
      [uuidOf(4), OPTIONS.workerId, 'missing', null],
    ]);
    expect(h.store.deleteToken).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      receipts_claimed: 4,
      receipts_ok: 1,
      receipts_error: 1,
      receipts_pending: 1,
      receipts_missing: 1,
    });

    // receipt を取れなかった回は、全行のリースを外すだけ (次の回で確かめ直す)
    const h2 = makeHarness({
      receiptRows: [makeReceiptRow(5), makeReceiptRow(6)],
      getReceipts: async () => ({ ok: false, failure: { code: 'network_error', message: 'x', statusCode: null, retryable: true } }),
    });
    const summary2 = await processPushOutbox(h2.deps, OPTIONS);
    expect(h2.store.recordReceipt.mock.calls).toEqual([
      [uuidOf(5), OPTIONS.workerId, null, null],
      [uuidOf(6), OPTIONS.workerId, null, null],
    ]);
    expect(summary2).toMatchObject({ receipts_claimed: 2, receipts_pending: 2, receipts_ok: 0 });
  });

  it('receipt の DeviceNotRegistered で端末の行を消す (S-10)', async () => {
    const h = makeHarness({
      receiptRows: [makeReceiptRow(1)],
      getReceipts: async () => ({
        ok: true,
        receipts: { 'receipt-1': { status: 'error', message: 'gone', details: { error: EXPO_DEVICE_NOT_REGISTERED } } },
      }),
    });

    const summary = await processPushOutbox(h.deps, OPTIONS);

    expect(h.store.recordReceipt).toHaveBeenCalledWith(uuidOf(1), OPTIONS.workerId, 'error', EXPO_DEVICE_NOT_REGISTERED);
    expect(h.store.deleteToken).toHaveBeenCalledWith(uuidOf(500_001));
    expect(summary).toMatchObject({ receipts_error: 1, tokens_removed: 1 });
  });

  it('processPushOutbox は cleanup の expired / sent / dead を要約の cleaned_* に入れる', async () => {
    const h = makeHarness({ cleanup: { expired: 3, sent: 5, dead: 7 } });

    const summary = await processPushOutbox(h.deps, OPTIONS);

    expect(h.store.cleanup).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ claimed: 0, cleaned_expired: 3, cleaned_sent: 5, cleaned_dead: 7 });
    // claim が 0 件なら利用者の条件を読まない
    expect(h.store.loadEligibility).not.toHaveBeenCalled();
  });
});

describe('定数の突き合わせ・ログ・設定 (#1136)', () => {
  it("PUSH_OUTBOX_QUEUED_MAX_AGE_MS と PUSH_OUTBOX_ERROR_CODES.EXPIRED が migration の cleanup_push_outbox の c_queued_max_age (24 hours)・'expired' と同じ (supabase/migrations/*_push_outbox.sql を読む)", () => {
    const dir = path.join(ROOT, 'supabase/migrations');
    const files = fs.readdirSync(dir).filter((name) => /^\d+_push_outbox\.sql$/.test(name));
    expect(files).toHaveLength(1);
    const sql = fs.readFileSync(path.join(dir, files[0]!), 'utf8');
    const cleanup = sql.slice(sql.indexOf('FUNCTION public.cleanup_push_outbox'));
    const maxAge = /c_queued_max_age CONSTANT interval := interval '(\d+) hours'/.exec(cleanup);
    expect(maxAge, 'c_queued_max_age の宣言').not.toBeNull();
    expect(Number(maxAge?.[1]) * MS_PER_HOUR).toBe(PUSH_OUTBOX_QUEUED_MAX_AGE_MS);
    const expiredCode = /last_error_code = '([a-z_]+)'/.exec(cleanup);
    expect(expiredCode?.[1]).toBe(PUSH_OUTBOX_ERROR_CODES.EXPIRED);
  });

  it('ログの meta に文面 (title / body)・token の全体・payload を出さない (R-15)', async () => {
    const rows = [
      makeRow(1), // ticket の DeviceNotRegistered → dead の warn + 端末の行の削除の warn
      makeRow(2, { payload: { request_id: uuidOf(700_002), start_date: 'bad' } }), // invalid_payload の dead の warn
      makeRow(3),
    ];
    const h = makeHarness({
      rows,
      receiptRows: [makeReceiptRow(4)],
      send: async (messages) =>
        messages.length > 1
          ? { ok: false, failure: { code: 'PUSH_TOO_MANY_EXPERIENCE_IDS', message: 'x', statusCode: 400, retryable: false } }
          : {
              ok: true,
              tickets: [
                messages[0]?.to === tokenOf(1)
                  ? { status: 'error', message: 'gone', details: { error: EXPO_DEVICE_NOT_REGISTERED } }
                  : { status: 'ok', id: 'ticket-x' },
              ],
            },
      getReceipts: async () => ({ ok: true, receipts: { 'receipt-4': { status: 'error', details: { error: 'MessageTooBig' } } } }),
    });

    await processPushOutbox(h.deps, OPTIONS);

    expect(h.warn.mock.calls.length).toBeGreaterThanOrEqual(4);
    const logged = JSON.stringify([...h.warn.mock.calls, ...h.info.mock.calls]);
    for (const n of [1, 2, 3, 4]) expect(logged).not.toContain(tokenOf(n));
    expect(logged).toContain('ExponentPushToken[…0001]');
    for (const secret of ['献立ができました', '献立を作れませんでした', START_DATE, '10月20日', uuidOf(700_001), uuidOf(700_002), uuidOf(700_003)]) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).not.toContain('"title"');
    expect(logged).not.toContain('"body"');
  });

  it('resolvePushOutboxSettings: 範囲外は既定に戻し ignored に名前', () => {
    expect(resolvePushOutboxSettings({ maxAttempts: undefined, batchSize: undefined })).toEqual({
      maxAttempts: PUSH_OUTBOX_MAX_ATTEMPTS,
      batchSize: PUSH_OUTBOX_BATCH_SIZE,
      ignored: [],
    });
    expect(resolvePushOutboxSettings({ maxAttempts: ' ', batchSize: '' })).toEqual({
      maxAttempts: PUSH_OUTBOX_MAX_ATTEMPTS,
      batchSize: PUSH_OUTBOX_BATCH_SIZE,
      ignored: [],
    });
    expect(resolvePushOutboxSettings({ maxAttempts: '10', batchSize: '1' })).toEqual({ maxAttempts: 10, batchSize: 1, ignored: [] });
    expect(resolvePushOutboxSettings({ maxAttempts: '1', batchSize: '500' })).toEqual({ maxAttempts: 1, batchSize: 500, ignored: [] });
    expect(resolvePushOutboxSettings({ maxAttempts: '11', batchSize: '501' })).toEqual({
      maxAttempts: PUSH_OUTBOX_MAX_ATTEMPTS,
      batchSize: PUSH_OUTBOX_BATCH_SIZE,
      ignored: ['PUSH_OUTBOX_MAX_ATTEMPTS', 'PUSH_OUTBOX_BATCH_SIZE'],
    });
    expect(resolvePushOutboxSettings({ maxAttempts: '0', batchSize: '2.5' }).ignored).toEqual([
      'PUSH_OUTBOX_MAX_ATTEMPTS',
      'PUSH_OUTBOX_BATCH_SIZE',
    ]);
    expect(resolvePushOutboxSettings({ maxAttempts: 'abc', batchSize: '50' })).toEqual({
      maxAttempts: PUSH_OUTBOX_MAX_ATTEMPTS,
      batchSize: 50,
      ignored: ['PUSH_OUTBOX_MAX_ATTEMPTS'],
    });
  });

  it('maskPushToken は末尾 4 文字だけ', () => {
    expect(maskPushToken('ExponentPushToken[abcdefgh1234]')).toBe('ExponentPushToken[…1234]');
    expect(maskPushToken('ExpoPushToken[xyzw9876]')).toBe('ExpoPushToken[…9876]');
    expect(maskPushToken('plain-token-wxyz')).toBe('…wxyz');
  });
});

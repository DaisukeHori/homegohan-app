/**
 * ストアの購読の定期の取り直しの facade (src/lib/billing/iap-reconcile-service.ts) の単体テスト (billing/04 §12.1 のテスト 11〜20)。
 * reconcileStoreSubscriptions と syncStoreSubscriber は本物を通す。RevenueCat の gateway・IapRepository・IapReconcileRepository・sleep・now は偽物
 * (DB も RevenueCat も使わない)。時計は偽物で、sleep と取り直しの所要時間だけが進める。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logs = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: logs.info, warn: logs.warn, error: logs.error }),
  generateRequestId: () => 'req-test',
}));

import { BillingRpcError } from '@/lib/billing/repository';
import {
  RevenueCatApiError,
  type ApplyStoreSubscriptionResult,
  type IapRepository,
  type PlanStoreProductRow,
  type RevenueCatCustomerInfo,
  type RevenueCatGateway,
  type RevenueCatSubscription,
  type StoreSubscriptionRow,
  type StoreSubscriptionSnapshot,
} from '@/lib/billing/iap-core';
import {
  IAP_RECONCILE_REQUEST_INTERVAL_MS,
  IAP_RECONCILE_RUN_BUDGET_MS,
  IapReconcileFailedError,
  type IapReconcileAttemptMark,
  type IapReconcileCandidate,
  type IapReconcileCandidateQuery,
  type IapReconcileRepository,
  type IapReconcileSummary,
} from '@/lib/billing/iap-reconcile-core';
import { reconcileStoreSubscriptions, type IapReconcileDeps } from '@/lib/billing/iap-reconcile-service';

/** n 番目の利用者 (UUID v4 の形) */
const uid = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const START_MS = Date.parse('2026-10-22T04:41:00.000Z');
const PAST = '2026-10-01T00:00:00.000Z';
const FUTURE = '2026-11-21T00:00:00.000Z';
const SETTINGS = { batchSize: 40, recheckHours: 6 };

const PRODUCTS: PlanStoreProductRow[] = [
  { plan_key: 'pro', store: 'app_store', billing_interval: 'month', product_id: 'homegohan_pro_month', offered: true },
];

function liveSub(overrides: Partial<RevenueCatSubscription> = {}): RevenueCatSubscription {
  return {
    expires_date: FUTURE,
    purchase_date: '2026-10-14T00:00:00.000Z',
    original_purchase_date: '2026-10-14T00:00:00.000Z',
    period_type: 'normal',
    store: 'app_store',
    is_sandbox: false,
    ...overrides,
  };
}

function customer(userId: string, subscriptions: Record<string, RevenueCatSubscription>): RevenueCatCustomerInfo {
  return { request_date: new Date(START_MS).toISOString(), subscriber: { original_app_user_id: userId, subscriptions } };
}

const candidate = (n: number, periodEnd = '2026-10-21T00:00:00+00:00'): IapReconcileCandidate => ({ user_id: uid(n), period_end: periodEnd, synced_at: null });

interface Harness {
  deps: IapReconcileDeps;
  events: string[];
  sleeps: number[];
  fetched: string[];
  applied: Array<{ snapshot: StoreSubscriptionSnapshot; fetchedAt: Date; source: string }>;
  listCalls: IapReconcileCandidateQuery[];
  markCalls: IapReconcileAttemptMark[];
  clock: { ms: number };
  reconcileRepository: IapReconcileRepository;
}

interface HarnessOptions {
  candidates: IapReconcileCandidate[];
  /** 取り直し 1 回の所要時間 (ms。既定 0) */
  fetchDurationMs?: number | ((userId: string, index: number) => number);
  /** 利用者ごとの customer (既定: 当社の月額の商品が live) */
  customerOf?: (userId: string) => RevenueCatCustomerInfo;
  /** gateway が投げる例外 (利用者ごと) */
  gatewayError?: (userId: string) => Error | null;
  /** 写像の結果・例外 (利用者ごと。既定は applied) */
  applyResult?: (userId: string) => ApplyStoreSubscriptionResult | Error;
  listStoreSubscriptions?: (userId: string) => StoreSubscriptionRow[];
  listError?: Error;
  listAdvanceMs?: number;
  markError?: Error;
}

function appliedResult(userId: string): ApplyStoreSubscriptionResult {
  return { applied: true, subscription_id: `row-${userId}`, user_id: userId, status_from: 'active', status_to: 'expired', plan_key: 'pro' };
}

function makeHarness(options: HarnessOptions): Harness {
  const clock = { ms: START_MS };
  const events: string[] = [];
  const sleeps: number[] = [];
  const fetched: string[] = [];
  const applied: Harness['applied'] = [];
  const listCalls: IapReconcileCandidateQuery[] = [];
  const markCalls: IapReconcileAttemptMark[] = [];
  const gateway: RevenueCatGateway = {
    getSubscriber: vi.fn(async (appUserId: string) => {
      const index = fetched.length;
      fetched.push(appUserId);
      events.push(`fetch:${appUserId}`);
      const duration = typeof options.fetchDurationMs === 'function' ? options.fetchDurationMs(appUserId, index) : (options.fetchDurationMs ?? 0);
      clock.ms += duration;
      const error = options.gatewayError?.(appUserId) ?? null;
      if (error) throw error;
      return options.customerOf ? options.customerOf(appUserId) : customer(appUserId, { homegohan_pro_month: liveSub() });
    }),
  };
  const repository: IapRepository = {
    listStoreProducts: vi.fn(async () => PRODUCTS),
    listStoreSubscriptions: vi.fn(async (userId: string) => options.listStoreSubscriptions?.(userId) ?? []),
    applyStoreSubscription: vi.fn(async (input: { snapshot: StoreSubscriptionSnapshot; fetchedAt: Date; source: string }) => {
      applied.push(input);
      const result = options.applyResult ? options.applyResult(input.snapshot.user_id) : appliedResult(input.snapshot.user_id);
      if (result instanceof Error) throw result;
      return result;
    }),
    claimRevenueCatEvent: vi.fn(async () => 'claimed' as const),
    finishRevenueCatEvent: vi.fn(async () => undefined),
    recordIapAudit: vi.fn(async () => undefined),
  };
  const reconcileRepository: IapReconcileRepository = {
    listReconcileCandidates: vi.fn(async (query: IapReconcileCandidateQuery) => {
      listCalls.push(query);
      clock.ms += options.listAdvanceMs ?? 0;
      if (options.listError) throw options.listError;
      return options.candidates;
    }),
    markReconcileAttempted: vi.fn(async (mark: IapReconcileAttemptMark) => {
      markCalls.push(mark);
      events.push('mark');
      if (options.markError) throw options.markError;
    }),
  };
  const deps: IapReconcileDeps = {
    gateway,
    repository,
    reconcileRepository,
    now: () => new Date(clock.ms),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      events.push(`sleep:${ms}`);
      clock.ms += ms;
    },
  };
  return { deps, events, sleeps, fetched, applied, listCalls, markCalls, clock, reconcileRepository };
}

async function failedSummary(promise: Promise<IapReconcileSummary>): Promise<IapReconcileSummary> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(IapReconcileFailedError);
    return (error as IapReconcileFailedError).summary;
  }
  throw new Error('IapReconcileFailedError が投げられなかった');
}

beforeEach(() => {
  logs.warn.mockReset();
  logs.error.mockReset();
  logs.info.mockReset();
});

describe('billing/04 §8.3 reconcileStoreSubscriptions', () => {
  it('reconcileStoreSubscriptions lists candidates with now / recheckHours / limit = batchSize, syncs each user in the returned order with source iap_reconcile through the given gateway and repository, sums the outcomes (synced / applied / stale / ended / no_subscription / skipped_unknown), and after the loop calls markReconcileAttempted once with every synced user id in order and attemptedAt equal to the listing now', async () => {
    const [a, b, c, d] = [uid(1), uid(2), uid(3), uid(4)];
    const harness = makeHarness({
      candidates: [candidate(1), candidate(2), candidate(3), candidate(4)],
      customerOf: (userId) => {
        // C: 当社の商品が無い (取り直した subscriptions に何も無い)。D: 対応の無い期限切れの商品 + 対応のある live な商品
        if (userId === c) return customer(userId, {});
        if (userId === d) return customer(userId, { old_unmapped: liveSub({ expires_date: PAST }), homegohan_pro_month: liveSub() });
        return customer(userId, { homegohan_pro_month: liveSub() });
      },
      // C は取り直しに無くなった live な行を 1 つ持つ (expired で終わらせる = ended)
      listStoreSubscriptions: (userId) =>
        userId === c
          ? [{ iap_store: 'app_store', iap_product_id: 'homegohan_pro_month', plan_key: 'pro', status: 'active', billing_interval: 'month', iap_is_sandbox: false, current_period_start: PAST, starts_at: PAST }]
          : [],
      // B は別の取り直しが先に写した
      applyResult: (userId) => (userId === b ? { applied: false, skipped: 'stale', subscription_id: 'row-b', user_id: b } : appliedResult(userId)),
    });

    const summary = await reconcileStoreSubscriptions(harness.deps, { batchSize: 25, recheckHours: 12 });

    expect(harness.listCalls).toEqual([{ now: new Date(START_MS), recheckHours: 12, limit: 25 }]);
    // 返された順に取り直す
    expect(harness.fetched).toEqual([a, b, c, d]);
    // 写像へ渡す出どころは iap_reconcile、取り直しの時刻は GET の前の時刻
    expect(harness.applied).toHaveLength(4);
    expect(harness.applied.every((input) => input.source === 'iap_reconcile')).toBe(true);
    expect(summary).toMatchObject({
      candidates: 4,
      synced: 4,
      applied: 2, // A と D の live な商品
      stale: 1, // B
      ended: 1, // C の行
      no_subscription: 1, // C
      skipped_unknown: 1, // D の対応の無い期限切れの商品
      rejected: {},
      failed: {},
      stopped_early: null,
      oldest_period_end: '2026-10-21T00:00:00+00:00',
    });
    // 印は回の終わりに 1 回だけ。試した利用者全員を順に、回の開始の時刻で
    expect(harness.markCalls).toEqual([{ userIds: [a, b, c, d], attemptedAt: new Date(START_MS) }]);
    expect(harness.markCalls[0].attemptedAt.getTime()).toBe(harness.listCalls[0].now.getTime());
    // 印の書き込みは取り直しがすべて終わったあと (最後の出来事で、1 回だけ)
    expect(harness.events[harness.events.length - 1]).toBe('mark');
    expect(harness.events.filter((event) => event === 'mark')).toHaveLength(1);
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('reconcileStoreSubscriptions does not sleep before the first fetch and sleeps IAP_RECONCILE_REQUEST_INTERVAL_MS minus the elapsed time between the starts of consecutive fetches (a fetch slower than the interval gets no sleep)', async () => {
    const interval = IAP_RECONCILE_REQUEST_INTERVAL_MS;
    const firstFetchMs = 300;
    const slowFetchMs = interval + 500;
    const harness = makeHarness({
      candidates: [candidate(1), candidate(2), candidate(3)],
      // 1 人目 300 ms、2 人目は間隔より遅い、3 人目は 0
      fetchDurationMs: (_userId, index) => [firstFetchMs, slowFetchMs, 0][index] ?? 0,
    });

    await reconcileStoreSubscriptions(harness.deps, SETTINGS);

    // 1 人目の前は待たない。2 人目は 1 人目の開始から 300 ms 経っているので残りだけ。3 人目は 2 人目の開始から間隔を超えているので待たない
    expect(harness.sleeps).toEqual([interval - firstFetchMs]);
    expect(harness.events).toEqual([`fetch:${uid(1)}`, `sleep:${interval - firstFetchMs}`, `fetch:${uid(2)}`, `fetch:${uid(3)}`]);
  });

  it('reconcileStoreSubscriptions stops with stopped_early = budget once now() minus the start exceeds IAP_RECONCILE_RUN_BUDGET_MS, leaving the remaining candidates untouched (not synced and not passed to markReconcileAttempted, which receives only the users tried before the stop), and sets elapsed_ms; when the budget is already exceeded before the first user, markReconcileAttempted is not called', async () => {
    // 1 人 15 秒かかる: 0 → 15 → 30 → 45 秒。4 人目の前 (45 秒 > 40 秒) で止まる
    const slowFetchMs = IAP_RECONCILE_RUN_BUDGET_MS * 0.375;
    const harness = makeHarness({
      candidates: [candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)],
      fetchDurationMs: slowFetchMs,
    });

    const summary = await reconcileStoreSubscriptions(harness.deps, SETTINGS);

    expect(summary.stopped_early).toBe('budget');
    expect(summary.candidates).toBe(5);
    expect(summary.synced).toBe(3);
    expect(summary.elapsed_ms).toBe(slowFetchMs * 3);
    // 4・5 人目は取り直しも印もしない
    expect(harness.fetched).toEqual([uid(1), uid(2), uid(3)]);
    expect(harness.markCalls).toEqual([{ userIds: [uid(1), uid(2), uid(3)], attemptedAt: new Date(START_MS) }]);

    // 最初の 1 人の前にもう予算を超えている回 (候補を読むのに予算を使い切った)
    const exhausted = makeHarness({ candidates: [candidate(1), candidate(2)], listAdvanceMs: IAP_RECONCILE_RUN_BUDGET_MS + 1 });
    const exhaustedSummary = await reconcileStoreSubscriptions(exhausted.deps, SETTINGS);
    expect(exhaustedSummary).toMatchObject({ stopped_early: 'budget', synced: 0, candidates: 2 });
    expect(exhausted.fetched).toEqual([]);
    expect(exhausted.reconcileRepository.markReconcileAttempted).not.toHaveBeenCalled();
  });

  it('reconcileStoreSubscriptions skips a user whose sync throws BillingRpcError (BILL_LIVE_ROW_CONFLICT) or IapError (BILL_IAP_UNKNOWN_PRODUCT), counts it in rejected by code, logs a warn with user_id and code, continues with the next user, passes the skipped user to markReconcileAttempted, and returns without throwing', async () => {
    const [conflict, unknownProduct, fine] = [uid(1), uid(2), uid(3)];
    const harness = makeHarness({
      candidates: [candidate(1), candidate(2), candidate(3)],
      // 2 人目: 対応の無い live な商品 (書く前に IapError)
      customerOf: (userId) => customer(userId, userId === unknownProduct ? { unknown_live: liveSub() } : { homegohan_pro_month: liveSub() }),
      // 1 人目: 別の live 行 (Stripe) がある
      applyResult: (userId) => (userId === conflict ? new BillingRpcError('BILL_LIVE_ROW_CONFLICT', null) : appliedResult(userId)),
    });

    const summary = await reconcileStoreSubscriptions(harness.deps, SETTINGS);

    expect(summary.rejected).toEqual({ BILL_LIVE_ROW_CONFLICT: 1, BILL_IAP_UNKNOWN_PRODUCT: 1 });
    expect(summary.failed).toEqual({});
    expect(summary.synced).toBe(1);
    expect(summary.stopped_early).toBeNull();
    expect(harness.fetched).toEqual([conflict, unknownProduct, fine]);
    expect(logs.warn).toHaveBeenCalledTimes(2);
    expect(logs.warn).toHaveBeenCalledWith('ストアの購読の取り直しを写せませんでした (運営の処置が要ります)', { user_id: conflict, code: 'BILL_LIVE_ROW_CONFLICT' });
    expect(logs.warn).toHaveBeenCalledWith('ストアの購読の取り直しを写せませんでした (運営の処置が要ります)', { user_id: unknownProduct, code: 'BILL_IAP_UNKNOWN_PRODUCT' });
    // 飛ばした利用者にも印を書く (候補に残るが、次の回は後ろに回る)
    expect(harness.markCalls).toEqual([{ userIds: [conflict, unknownProduct, fine], attemptedAt: new Date(START_MS) }]);
  });

  it('reconcileStoreSubscriptions stops with stopped_early = rate_limited and returns the summary without throwing on RevenueCatApiError status 429, logging a warn; markReconcileAttempted receives the users up to and including the one that got 429, not the later ones', async () => {
    const harness = makeHarness({
      candidates: [candidate(1), candidate(2), candidate(3), candidate(4)],
      gatewayError: (userId) => (userId === uid(2) ? new RevenueCatApiError({ status: 429 }) : null),
    });

    const summary = await reconcileStoreSubscriptions(harness.deps, SETTINGS);

    expect(summary).toMatchObject({ candidates: 4, synced: 1, stopped_early: 'rate_limited', failed: {}, rejected: {} });
    expect(harness.fetched).toEqual([uid(1), uid(2)]);
    expect(logs.warn).toHaveBeenCalledWith('RevenueCat の率の制限 (429) のため、この回の取り直しを止めました (残りは次の回)', { candidates: 4, synced: 1 });
    expect(harness.markCalls).toEqual([{ userIds: [uid(1), uid(2)], attemptedAt: new Date(START_MS) }]);
  });

  it('reconcileStoreSubscriptions on RevenueCatApiError status null / 401 / 403 / 503 for the first user counts failed by kind, sets stopped_early = revenuecat_unavailable, does not fetch the next user, marks only the first user, and throws IapReconcileFailedError carrying the summary', async () => {
    const cases: Array<{ status: number | null; kind: keyof IapReconcileSummary['failed'] }> = [
      { status: null, kind: 'revenuecat_unreachable' },
      { status: 401, kind: 'revenuecat_unauthorized' },
      { status: 403, kind: 'revenuecat_unauthorized' },
      { status: 503, kind: 'revenuecat_server_error' },
    ];
    for (const { status, kind } of cases) {
      logs.warn.mockReset();
      const harness = makeHarness({
        candidates: [candidate(1), candidate(2), candidate(3)],
        gatewayError: (userId) => (userId === uid(1) ? new RevenueCatApiError({ status }) : null),
      });

      const summary = await failedSummary(reconcileStoreSubscriptions(harness.deps, SETTINGS));

      expect(summary.failed, String(status)).toEqual({ [kind]: 1 });
      expect(summary.stopped_early, String(status)).toBe('revenuecat_unavailable');
      expect(summary.synced, String(status)).toBe(0);
      expect(harness.fetched, String(status)).toEqual([uid(1)]);
      expect(harness.markCalls, String(status)).toEqual([{ userIds: [uid(1)], attemptedAt: new Date(START_MS) }]);
      expect(logs.warn, String(status)).toHaveBeenCalledWith('ストアの購読を取り直せませんでした', expect.objectContaining({ user_id: uid(1), kind, scope: 'run' }));
    }
  });

  it('reconcileStoreSubscriptions on a per-user failure of the first user (RevenueCatApiError status 200 unexpected shape, status 404, a BillingRpcError BILL_UNKNOWN_PLAN or BILL_UNKNOWN_IAP_STATUS from applyStoreSubscription (kind internal, error_code = the code, rejected stays {}), or a non-business PostgrestError from applyStoreSubscription) counts failed by kind, logs a warn with user_id / kind / error_code, still syncs every later user, marks every user including the failed one, and then throws IapReconcileFailedError whose summary has the later users in synced', async () => {
    const postgrestError = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    const cases: Array<{
      label: string;
      kind: keyof IapReconcileSummary['failed'];
      gatewayError?: Error;
      applyError?: Error;
      errorName: string;
      errorCode: string | null;
    }> = [
      { label: '200 unexpected shape', kind: 'revenuecat_unexpected_response', gatewayError: new RevenueCatApiError({ status: 200, rawMessage: 'unexpected response shape' }), errorName: 'RevenueCatApiError', errorCode: null },
      { label: '404', kind: 'revenuecat_client_error', gatewayError: new RevenueCatApiError({ status: 404 }), errorName: 'RevenueCatApiError', errorCode: null },
      { label: 'BILL_UNKNOWN_PLAN', kind: 'internal', applyError: new BillingRpcError('BILL_UNKNOWN_PLAN', null), errorName: 'BillingRpcError', errorCode: 'BILL_UNKNOWN_PLAN' },
      { label: 'BILL_UNKNOWN_IAP_STATUS', kind: 'internal', applyError: new BillingRpcError('BILL_UNKNOWN_IAP_STATUS', null), errorName: 'BillingRpcError', errorCode: 'BILL_UNKNOWN_IAP_STATUS' },
      { label: 'PostgrestError', kind: 'internal', applyError: postgrestError, errorName: 'Error', errorCode: '23505' },
    ];
    for (const item of cases) {
      logs.warn.mockReset();
      const harness = makeHarness({
        candidates: [candidate(1), candidate(2), candidate(3)],
        gatewayError: (userId) => (userId === uid(1) ? (item.gatewayError ?? null) : null),
        applyResult: (userId) => (userId === uid(1) && item.applyError ? item.applyError : appliedResult(userId)),
      });

      const summary = await failedSummary(reconcileStoreSubscriptions(harness.deps, SETTINGS));

      expect(summary.failed, item.label).toEqual({ [item.kind]: 1 });
      expect(summary.rejected, item.label).toEqual({});
      expect(summary.stopped_early, item.label).toBeNull();
      // 後ろの 2 人は取り直して写す
      expect(summary.synced, item.label).toBe(2);
      expect(harness.fetched, item.label).toEqual([uid(1), uid(2), uid(3)]);
      expect(harness.markCalls, item.label).toEqual([{ userIds: [uid(1), uid(2), uid(3)], attemptedAt: new Date(START_MS) }]);
      expect(logs.warn, item.label).toHaveBeenCalledWith(
        'ストアの購読を取り直せませんでした',
        { user_id: uid(1), kind: item.kind, scope: 'user', error_name: item.errorName, error_code: item.errorCode },
      );
    }
  });

  it('reconcileStoreSubscriptions throws IapReconcileFailedError when a 429 stops a run that already has a per-user failure, rethrows the original error without syncing or marking anyone when listReconcileCandidates fails, and rethrows a markReconcileAttempted failure after the users were synced', async () => {
    // (1) 1 人目が利用者 1 人の失敗 (404)、2 人目が 429 で止まる → 失敗の回 (500)
    const mixed = makeHarness({
      candidates: [candidate(1), candidate(2), candidate(3)],
      gatewayError: (userId) => {
        if (userId === uid(1)) return new RevenueCatApiError({ status: 404 });
        if (userId === uid(2)) return new RevenueCatApiError({ status: 429 });
        return null;
      },
    });
    const mixedSummary = await failedSummary(reconcileStoreSubscriptions(mixed.deps, SETTINGS));
    expect(mixedSummary).toMatchObject({ stopped_early: 'rate_limited', failed: { revenuecat_client_error: 1 }, synced: 0 });
    expect(mixed.fetched).toEqual([uid(1), uid(2)]);
    expect(mixed.markCalls).toEqual([{ userIds: [uid(1), uid(2)], attemptedAt: new Date(START_MS) }]);

    // (2) 候補を読む RPC の失敗: 誰も取り直さず、印も書かず、元の例外をそのまま投げる
    const listError = Object.assign(new Error('permission denied for function billing_iap_reconcile_candidates'), { code: '42501' });
    const listFailing = makeHarness({ candidates: [candidate(1)], listError });
    await expect(reconcileStoreSubscriptions(listFailing.deps, SETTINGS)).rejects.toBe(listError);
    expect(listFailing.fetched).toEqual([]);
    expect(listFailing.reconcileRepository.markReconcileAttempted).not.toHaveBeenCalled();

    // (3) 印の RPC の失敗: 取り直しと写しは済んでいる。元の例外をそのまま投げる (IapReconcileFailedError にしない)
    const markError = Object.assign(new Error('insert or update on table "iap_reconcile_attempts" violates foreign key constraint'), { code: '23503' });
    const markFailing = makeHarness({ candidates: [candidate(1), candidate(2)], markError });
    await expect(reconcileStoreSubscriptions(markFailing.deps, SETTINGS)).rejects.toBe(markError);
    expect(markFailing.fetched).toEqual([uid(1), uid(2)]);
    expect(markFailing.applied.map((input) => input.snapshot.user_id)).toEqual([uid(1), uid(2)]);
  });

  it('reconcileStoreSubscriptions with no candidates calls neither the gateway, sleep nor markReconcileAttempted and returns candidates 0 / failed {} / stopped_early null / oldest_period_end null', async () => {
    const harness = makeHarness({ candidates: [] });

    const summary = await reconcileStoreSubscriptions(harness.deps, SETTINGS);

    expect(summary).toMatchObject({ candidates: 0, synced: 0, failed: {}, rejected: {}, stopped_early: null, oldest_period_end: null, elapsed_ms: 0 });
    expect(harness.deps.gateway.getSubscriber).not.toHaveBeenCalled();
    expect(harness.sleeps).toEqual([]);
    expect(harness.reconcileRepository.markReconcileAttempted).not.toHaveBeenCalled();
  });

  it('reconcileStoreSubscriptions counts a user_deleted outcome only in synced (applied / stale unchanged)', async () => {
    const harness = makeHarness({
      candidates: [candidate(1)],
      applyResult: () => ({ applied: false, skipped: 'user_deleted' }),
    });

    const summary = await reconcileStoreSubscriptions(harness.deps, SETTINGS);

    expect(summary).toMatchObject({ synced: 1, applied: 0, stale: 0, ended: 0, no_subscription: 0, skipped_unknown: 0, failed: {}, rejected: {} });
    // 試した利用者としては印を渡す (印の関数が auth.users に無い利用者を飛ばす)
    expect(harness.markCalls).toEqual([{ userIds: [uid(1)], attemptedAt: new Date(START_MS) }]);
  });
});

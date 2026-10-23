/**
 * アプリ内課金のユースケース (src/lib/billing/iap-service.ts) の単体テスト (billing/03 §14.1 のテスト 17〜24・136)。
 * RevenueCat の gateway と repository は偽物を渡す (DB も RevenueCat も使わない)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logs = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: logs.warn, error: logs.error }),
  generateRequestId: () => 'req-test',
}));

import { BillingRpcError } from '@/lib/billing/repository';
import {
  IapError,
  type ApplyStoreSubscriptionResult,
  type IapAuditEntry,
  type IapRepository,
  type PlanStoreProductRow,
  type RevenueCatCustomerInfo,
  type RevenueCatEvent,
  type RevenueCatGateway,
  type RevenueCatSubscription,
  type StoreSubscriptionRow,
  type StoreSubscriptionSnapshot,
  type StoredRevenueCatEventPayload,
} from '@/lib/billing/iap-core';
import {
  handleRevenueCatEvent,
  lazyResyncStoreSubscription,
  recordRevenueCatEventFailure,
  syncStoreSubscriber,
  type IapDeps,
} from '@/lib/billing/iap-service';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-21T00:00:00.000Z');
const PAST = '2026-10-01T00:00:00.000Z';
const FUTURE = '2026-11-21T00:00:00.000Z';

const PRODUCTS: PlanStoreProductRow[] = [
  { plan_key: 'pro', store: 'app_store', billing_interval: 'month', product_id: 'homegohan_pro_month', offered: true },
  { plan_key: 'pro', store: 'app_store', billing_interval: 'year', product_id: 'homegohan_pro_year', offered: true },
  { plan_key: 'family_pro', store: 'app_store', billing_interval: 'month', product_id: 'homegohan_family_pro_month', offered: true },
  { plan_key: 'pro', store: 'play_store', billing_interval: 'month', product_id: 'homegohan_pro:monthly-autorenewing', offered: true },
];

function sub(overrides: Partial<RevenueCatSubscription> = {}): RevenueCatSubscription {
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

function customer(subscriptions: Record<string, RevenueCatSubscription>, userId = USER): RevenueCatCustomerInfo {
  return { request_date: NOW.toISOString(), subscriber: { original_app_user_id: userId, subscriptions } };
}

const APPLIED: ApplyStoreSubscriptionResult = {
  applied: true, subscription_id: 'row-1', user_id: USER, status_from: null, status_to: 'active', plan_key: 'pro',
};

function makeGateway(byUser: Record<string, RevenueCatCustomerInfo>) {
  const getSubscriber = vi.fn(async (appUserId: string) => byUser[appUserId] ?? customer({}, appUserId));
  const gateway: RevenueCatGateway = { getSubscriber };
  return { gateway, getSubscriber };
}

function makeRepository(overrides: Partial<IapRepository> = {}) {
  const audits: IapAuditEntry[] = [];
  const applied: Array<{ snapshot: StoreSubscriptionSnapshot; fetchedAt: Date; source: string }> = [];
  const base = {
    listStoreProducts: vi.fn(async (): Promise<PlanStoreProductRow[]> => PRODUCTS),
    listStoreSubscriptions: vi.fn(async (_userId: string): Promise<StoreSubscriptionRow[]> => []),
    applyStoreSubscription: vi.fn(async (input: { snapshot: StoreSubscriptionSnapshot; fetchedAt: Date; source: string }): Promise<ApplyStoreSubscriptionResult> => {
      applied.push(input);
      return APPLIED;
    }),
    claimRevenueCatEvent: vi.fn(async (_payload: StoredRevenueCatEventPayload) => 'claimed' as const),
    finishRevenueCatEvent: vi.fn(async (_eventId: string, _outcome: { ok: true } | { ok: false; errorCode: string }) => undefined),
    recordIapAudit: vi.fn(async (entry: IapAuditEntry) => {
      audits.push(entry);
    }),
  };
  return { repository: Object.assign(base, overrides), audits, applied };
}

function deps(gateway: RevenueCatGateway, repository: IapRepository): IapDeps {
  return { gateway, repository, now: () => NOW };
}

function event(overrides: Partial<RevenueCatEvent> = {}): RevenueCatEvent {
  return { id: 'evt_1', type: 'RENEWAL', event_timestamp_ms: 1_760_000_000_000, app_user_id: USER, ...overrides };
}

beforeEach(() => {
  logs.warn.mockReset();
  logs.error.mockReset();
});

describe('billing/03 §8.4 syncStoreSubscriber', () => {
  it('syncStoreSubscriber fetches the subscriber, applies non-live entries before live ones and returns counts', async () => {
    const { gateway, getSubscriber } = makeGateway({
      [USER]: customer({
        homegohan_pro_year: sub({ expires_date: '2027-10-14T00:00:00.000Z' }),
        homegohan_pro_month: sub({ expires_date: PAST }),
      }),
    });
    const { repository, applied } = makeRepository({
      applyStoreSubscription: vi
        .fn()
        .mockImplementationOnce(async (input) => {
          applied.push(input);
          return { applied: false, skipped: 'stale', subscription_id: 'row-0', user_id: USER } satisfies ApplyStoreSubscriptionResult;
        })
        .mockImplementationOnce(async (input) => {
          applied.push(input);
          return APPLIED;
        }),
    });
    const outcome = await syncStoreSubscriber(deps(gateway, repository), USER, 'iap_sync');
    expect(getSubscriber).toHaveBeenCalledWith(USER);
    expect(repository.listStoreSubscriptions).toHaveBeenCalledWith(USER);
    // 期限切れの月額 (live でない) が先、年額 (live) が後
    expect(applied.map((input) => [input.snapshot.iap_product_id, input.snapshot.iap_status])).toEqual([
      ['homegohan_pro_month', 'expired'],
      ['homegohan_pro_year', 'active'],
    ]);
    expect(applied.every((input) => input.source === 'iap_sync' && input.fetchedAt === NOW)).toBe(true);
    expect(applied[1].snapshot).toMatchObject({ user_id: USER, plan_key: 'pro', billing_interval: 'year', iap_store: 'app_store' });
    expect(outcome).toEqual({ user_id: USER, applied: 1, stale: 1, no_subscription: false, ended: 0, skipped_unknown: 0 });
  });

  it('syncStoreSubscriber throws BILL_IAP_UNKNOWN_PRODUCT before any write when a live store subscription has neither a plan_store_products row nor a user row, skips an unmapped expired entry without a row (skipped_unknown) while applying the mapped live entry, and applies an unmapped entry that already has a user row with plan_key null', async () => {
    // (1) 対応の行も利用者の行も無い live な商品 → 何も書かずに 422 の元
    const unknownLive = makeGateway({ [USER]: customer({ homegohan_pro_month: sub({ expires_date: PAST }), unknown_live: sub() }) });
    const rejected = makeRepository();
    await expect(syncStoreSubscriber(deps(unknownLive.gateway, rejected.repository), USER, 'iap_sync')).rejects.toMatchObject({
      name: 'IapError',
      code: 'BILL_IAP_UNKNOWN_PRODUCT',
    });
    expect(rejected.repository.applyStoreSubscription).not.toHaveBeenCalled();

    // (2) 対応の行も利用者の行も無い期限切れの商品は飛ばし、対応のある live な商品は写す
    const skipping = makeGateway({ [USER]: customer({ old_expired: sub({ expires_date: PAST }), homegohan_pro_month: sub() }) });
    const skipped = makeRepository();
    const outcome = await syncStoreSubscriber(deps(skipping.gateway, skipped.repository), USER, 'iap_sync');
    expect(skipped.applied.map((input) => input.snapshot.iap_product_id)).toEqual(['homegohan_pro_month']);
    expect(outcome).toMatchObject({ applied: 1, skipped_unknown: 1, no_subscription: false });

    // (3) 対応の行が無いが利用者の行がある商品は plan_key null の snapshot で写す (SQL が行の plan_key を使う)
    const existing = makeGateway({ [USER]: customer({ legacy_product: sub() }) });
    const withRow = makeRepository({
      listStoreSubscriptions: vi.fn(async (): Promise<StoreSubscriptionRow[]> => [
        { iap_store: 'app_store', iap_product_id: 'legacy_product', plan_key: 'pro', status: 'active', billing_interval: 'month', iap_is_sandbox: false, current_period_start: PAST, starts_at: PAST },
      ]),
    });
    await syncStoreSubscriber(deps(existing.gateway, withRow.repository), USER, 'iap_sync');
    expect(withRow.applied).toHaveLength(1);
    expect(withRow.applied[0].snapshot).toMatchObject({ iap_product_id: 'legacy_product', plan_key: null, billing_interval: null, iap_status: 'active' });
  });

  it('syncStoreSubscriber ends live store rows that are missing from the subscriber (TRANSFER away) with an expired snapshot carrying the row is_sandbox and billing_interval, and leaves non-live rows alone', async () => {
    const { gateway } = makeGateway({ [USER]: customer({}) });
    const { repository, applied } = makeRepository({
      listStoreSubscriptions: vi.fn(async (): Promise<StoreSubscriptionRow[]> => [
        { iap_store: 'app_store', iap_product_id: 'homegohan_pro_month', plan_key: 'pro', status: 'active', billing_interval: 'month', iap_is_sandbox: true, current_period_start: '2026-10-14T00:00:00.000Z', starts_at: PAST },
        { iap_store: 'play_store', iap_product_id: 'homegohan_pro:monthly-autorenewing', plan_key: 'pro', status: 'past_due', billing_interval: null, iap_is_sandbox: false, current_period_start: null, starts_at: PAST },
        { iap_store: 'app_store', iap_product_id: 'homegohan_pro_year', plan_key: 'pro', status: 'expired', billing_interval: 'year', iap_is_sandbox: false, current_period_start: PAST, starts_at: PAST },
        { iap_store: 'app_store', iap_product_id: 'homegohan_family_pro_month', plan_key: 'family_pro', status: 'cancelled', billing_interval: 'month', iap_is_sandbox: false, current_period_start: PAST, starts_at: PAST },
      ]),
    });
    const outcome = await syncStoreSubscriber(deps(gateway, repository), USER, 'revenuecat:evt_9');
    expect(applied.map((input) => input.snapshot)).toEqual([
      {
        user_id: USER, iap_store: 'app_store', iap_product_id: 'homegohan_pro_month', plan_key: 'pro', billing_interval: 'month',
        iap_status: 'expired', is_sandbox: true, purchase_date: '2026-10-14T00:00:00.000Z', original_purchase_date: null,
        expires_date: NOW.toISOString(), cancel_at_period_end: false, refunded_at: null, store_transaction_id: null,
      },
      {
        user_id: USER, iap_store: 'play_store', iap_product_id: 'homegohan_pro:monthly-autorenewing', plan_key: 'pro', billing_interval: null,
        iap_status: 'expired', is_sandbox: false, purchase_date: PAST, original_purchase_date: null,
        expires_date: NOW.toISOString(), cancel_at_period_end: false, refunded_at: null, store_transaction_id: null,
      },
    ]);
    expect(applied.every((input) => input.source === 'revenuecat:evt_9')).toBe(true);
    expect(outcome).toEqual({ user_id: USER, applied: 0, stale: 0, no_subscription: true, ended: 2, skipped_unknown: 0 });
  });

  it('syncStoreSubscriber reports no_subscription when the subscriber has no app_store / play_store entries and writes nothing', async () => {
    const { gateway } = makeGateway({ [USER]: customer({ promo: sub({ store: 'promotional' }), web: sub({ store: 'stripe' }) }) });
    const { repository } = makeRepository();
    expect(await syncStoreSubscriber(deps(gateway, repository), USER, 'iap_sync')).toEqual({
      user_id: USER, applied: 0, stale: 0, no_subscription: true, ended: 0, skipped_unknown: 0,
    });
    expect(repository.applyStoreSubscription).not.toHaveBeenCalled();
  });

  it('syncStoreSubscriber applies a superseded App Store entry first as an expired snapshot with the source suffixed :superseded and then the winner with the plain source, so an upgrade during a trial neither throws BILL_LIVE_ROW_CONFLICT nor keeps the old plan', async () => {
    const { gateway } = makeGateway({
      [USER]: customer({
        homegohan_pro_month: sub({ period_type: 'trial', purchase_date: '2026-10-15T00:00:00.000Z', expires_date: '2026-10-22T00:00:00.000Z' }),
        homegohan_family_pro_month: sub({ purchase_date: '2026-10-18T00:00:00.000Z', expires_date: '2026-11-18T00:00:00.000Z' }),
      }),
    });
    const { repository, applied } = makeRepository();
    await syncStoreSubscriber(deps(gateway, repository), USER, 'revenuecat:evt_up');
    expect(applied.map((input) => [input.snapshot.iap_product_id, input.snapshot.iap_status, input.snapshot.plan_key, input.source])).toEqual([
      ['homegohan_pro_month', 'expired', 'pro', 'revenuecat:evt_up:superseded'],
      ['homegohan_family_pro_month', 'active', 'family_pro', 'revenuecat:evt_up'],
    ]);
    expect(applied[0].snapshot).toMatchObject({ expires_date: '2026-10-18T00:00:00.000Z', cancel_at_period_end: false });
  });
});

describe('billing/03 §8.4 handleRevenueCatEvent / recordRevenueCatEventFailure', () => {
  it('handleRevenueCatEvent syncs both transferred_from and transferred_to for TRANSFER and ignores TEST', async () => {
    const { gateway, getSubscriber } = makeGateway({ [OTHER_USER]: customer({ homegohan_pro_month: sub() }, OTHER_USER) });
    const { repository } = makeRepository();
    const transfer = await handleRevenueCatEvent(
      deps(gateway, repository),
      event({ type: 'TRANSFER', app_user_id: undefined, transferred_from: [USER], transferred_to: [OTHER_USER] }),
    );
    expect(getSubscriber.mock.calls.map((call) => call[0])).toEqual([USER, OTHER_USER]);
    expect(transfer).toEqual({ action: 'synced', detail: '0/0/0/0/none,1/0/0/0' });
    // 写像の p_source は revenuecat:<event.id>
    expect(repository.applyStoreSubscription.mock.calls[0][0].source).toBe('revenuecat:evt_1');

    getSubscriber.mockClear();
    expect(await handleRevenueCatEvent(deps(gateway, repository), event({ type: 'TEST' }))).toEqual({ action: 'ignored', detail: 'TEST' });
    // 匿名 ID だけのイベントも取り直さない
    expect(await handleRevenueCatEvent(deps(gateway, repository), event({ app_user_id: '$RCAnonymousID:abc' }))).toEqual({ action: 'ignored', detail: 'RENEWAL' });
    expect(getSubscriber).not.toHaveBeenCalled();
  });

  it('handleRevenueCatEvent lets BILL_LIVE_ROW_CONFLICT propagate (route records the failure)', async () => {
    const { gateway } = makeGateway({ [USER]: customer({ homegohan_pro_month: sub() }) });
    const { repository } = makeRepository({
      applyStoreSubscription: vi.fn(async () => {
        throw new BillingRpcError('BILL_LIVE_ROW_CONFLICT', 'row-stripe');
      }),
    });
    await expect(handleRevenueCatEvent(deps(gateway, repository), event())).rejects.toMatchObject({ name: 'BillingRpcError', code: 'BILL_LIVE_ROW_CONFLICT' });
    expect(repository.finishRevenueCatEvent).not.toHaveBeenCalled();
  });

  it('recordRevenueCatEventFailure marks the event failed and audits system.revenuecat.event_failed (audit is fail-open)', async () => {
    const { gateway } = makeGateway({});
    const { repository, audits } = makeRepository();
    await recordRevenueCatEventFailure(deps(gateway, repository), event({ id: 'evt_f', type: 'RENEWAL' }), 'BILL_LIVE_ROW_CONFLICT');
    expect(repository.finishRevenueCatEvent).toHaveBeenCalledWith('evt_f', { ok: false, errorCode: 'BILL_LIVE_ROW_CONFLICT' });
    expect(audits).toEqual([
      {
        actor_id: null,
        action_type: 'system.revenuecat.event_failed',
        target_type: 'revenuecat_event',
        target_id: null,
        severity: 'warn',
        details: { event_id: 'evt_f', event_type: 'RENEWAL', error_code: 'BILL_LIVE_ROW_CONFLICT' },
      },
    ]);
    // 監査の失敗は飲み込む (ログに残す)
    const failingAudit = makeRepository({ recordIapAudit: vi.fn(async () => Promise.reject(new Error('audit down'))) });
    await expect(recordRevenueCatEventFailure(deps(gateway, failingAudit.repository), event(), 'SYS_INTERNAL_ERROR')).resolves.toBeUndefined();
    expect(failingAudit.repository.finishRevenueCatEvent).toHaveBeenCalledTimes(1);
    expect(logs.error).toHaveBeenCalledTimes(1);
    // finish(ok=false) の失敗は投げる (route が 500)
    const failingFinish = makeRepository({ finishRevenueCatEvent: vi.fn(async () => Promise.reject(new Error('db down'))) });
    await expect(recordRevenueCatEventFailure(deps(gateway, failingFinish.repository), event(), 'SYS_INTERNAL_ERROR')).rejects.toThrow('db down');
  });
});

describe('billing/03 §8.4 lazyResyncStoreSubscription', () => {
  it('lazyResyncStoreSubscription syncs only when needsLazyResync and swallows failures', async () => {
    const { gateway, getSubscriber } = makeGateway({ [USER]: customer({ homegohan_pro_month: sub() }) });
    const { repository, applied } = makeRepository();
    // 期限の中の行・Stripe の行・行なし・5 分以内に取り直した行は取り直さない
    const fresh = new Date(NOW.getTime() - 60 * 1000).toISOString();
    for (const row of [
      null,
      { iap_store: null, current_period_end: PAST, iap_synced_at: null },
      { iap_store: 'app_store', current_period_end: FUTURE, iap_synced_at: null },
      { iap_store: 'app_store', current_period_end: PAST, iap_synced_at: fresh },
    ]) {
      await lazyResyncStoreSubscription(deps(gateway, repository), USER, row);
    }
    expect(getSubscriber).not.toHaveBeenCalled();
    // 期限を過ぎ、古い取り直しのストアの行は取り直して写す (p_source = iap_lazy_resync)
    await lazyResyncStoreSubscription(deps(gateway, repository), USER, { iap_store: 'app_store', current_period_end: PAST, iap_synced_at: PAST });
    expect(getSubscriber).toHaveBeenCalledWith(USER);
    expect(applied.map((input) => input.source)).toEqual(['iap_lazy_resync']);
    // 失敗 (RevenueCat・写像の衝突・対応の行が無い) は飲み込み、コードだけを warn に残す
    for (const error of [new BillingRpcError('BILL_LIVE_ROW_CONFLICT', null), new IapError('BILL_IAP_UNKNOWN_PRODUCT'), new Error('network')]) {
      logs.warn.mockReset();
      const failing = makeRepository({ applyStoreSubscription: vi.fn(async () => Promise.reject(error)) });
      await expect(
        lazyResyncStoreSubscription(deps(gateway, failing.repository), USER, { iap_store: 'play_store', current_period_end: PAST, iap_synced_at: null }),
      ).resolves.toBeUndefined();
      expect(logs.warn).toHaveBeenCalledTimes(1);
      const expectedCode = error instanceof BillingRpcError || error instanceof IapError ? error.code : 'unknown';
      expect(logs.warn.mock.calls[0][1]).toEqual({ user_id: USER, code: expectedCode });
    }
  });
});

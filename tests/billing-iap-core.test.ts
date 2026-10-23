/**
 * アプリ内課金の核の純粋な部分 (src/lib/billing/iap-core.ts) の単体テスト (billing/03 §14.1 のテスト 1〜13・85・95・113・125・134・135)。
 * DB も RevenueCat も使わない。期待値は設計書の表をリテラルで書く (iap-core.ts の定数から組み立てない)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PURCHASE_STORES } from '@homegohan/shared';
import {
  IAP_ERROR_MESSAGES,
  IAP_LAZY_RESYNC_MIN_INTERVAL_MS,
  IAP_STORES,
  RevenueCatCustomerInfoSchema,
  RevenueCatWebhookEnvelopeSchema,
  appUserIdsToSync,
  buildIapCatalog,
  classifyRevenueCatEvent,
  compareStoreSubscriptionRecency,
  deriveStoreStatus,
  minimizeRevenueCatEventPayload,
  needsLazyResync,
  projectMissingSubscription,
  projectStoreSubscription,
  selectStoreSubscriptions,
  unmappedStoreSubscriptionDecision,
  type PlanStoreProductRow,
  type RevenueCatCustomerInfo,
  type RevenueCatEvent,
  type RevenueCatSubscription,
} from '@/lib/billing/iap-core';

/** 未完成や予定を示す語 (billing/03 §14.1 の冒頭。発注者の指示「「まだできてません」みたいなのは書かないで」) */
const UNFINISHED_WORDS = ['準備中', '販売開始前', '近日', '予定', 'まだ', '確定次第', 'これから'] as const;

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const NOW_MS = Date.parse('2026-10-21T00:00:00.000Z');
const PAST = '2026-10-01T00:00:00.000Z';
const FUTURE = '2026-11-21T00:00:00.000Z';

function sub(overrides: Partial<RevenueCatSubscription> = {}): RevenueCatSubscription {
  return {
    expires_date: FUTURE,
    purchase_date: '2026-10-14T00:00:00.000Z',
    original_purchase_date: '2026-10-14T00:00:00.000Z',
    period_type: 'normal',
    store: 'app_store',
    is_sandbox: false,
    unsubscribe_detected_at: null,
    billing_issues_detected_at: null,
    grace_period_expires_date: null,
    refunded_at: null,
    store_transaction_id: '2000000000000001',
    ...overrides,
  };
}

function info(subscriptions: Record<string, RevenueCatSubscription>): RevenueCatCustomerInfo {
  return { request_date: '2026-10-21T00:00:00Z', subscriber: { original_app_user_id: USER, subscriptions } };
}

const PRO_MONTH: PlanStoreProductRow = { plan_key: 'pro', store: 'app_store', billing_interval: 'month', product_id: 'homegohan_pro_month', offered: true };

describe('billing/03 §8.1 iap-core: I/O を持たない', () => {
  it('iap-core imports only zod (no I/O, no @/lib)', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/billing/iap-core.ts'), 'utf8');
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    expect(specifiers).toEqual(['zod']);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/process\.env/);
  });
});

describe('billing/03 §8.1 iap-core: イベントの振り分け', () => {
  it('classifyRevenueCatEvent maps the 21 documented types and treats unknown types as sync', () => {
    // 一次情報 (P4) の 21 種と、本冊の振り分け (§8.1 の表) をリテラルで持つ
    const expected: Record<string, 'sync' | 'sync_transfer' | 'ignore'> = {
      TEST: 'ignore',
      INITIAL_PURCHASE: 'sync',
      RENEWAL: 'sync',
      CANCELLATION: 'sync',
      UNCANCELLATION: 'sync',
      NON_RENEWING_PURCHASE: 'sync',
      SUBSCRIPTION_PAUSED: 'sync',
      EXPIRATION: 'sync',
      BILLING_ISSUE: 'sync',
      PRODUCT_CHANGE: 'sync',
      SUBSCRIPTION_EXTENDED: 'sync',
      REFUND_REVERSED: 'sync',
      INVOICE_ISSUANCE: 'ignore',
      TRANSFER: 'sync_transfer',
      TEMPORARY_ENTITLEMENT_GRANT: 'sync',
      VIRTUAL_CURRENCY_TRANSACTION: 'ignore',
      EXPERIMENT_ENROLLMENT: 'ignore',
      PURCHASE_REDEEMED: 'sync',
      SUBSCRIBER_ALIAS: 'ignore',
      PRICE_INCREASE_CONSENT_REQUIRED: 'ignore',
      PRICE_INCREASE_CONSENT_APPROVED: 'ignore',
    };
    expect(Object.keys(expected)).toHaveLength(21);
    for (const [type, action] of Object.entries(expected)) expect(classifyRevenueCatEvent(type), type).toBe(action);
    // 知らない種類は取り直しの合図として扱う。Object の既定の名前 (toString など) は知らない種類
    expect(classifyRevenueCatEvent('SOMETHING_NEW')).toBe('sync');
    expect(classifyRevenueCatEvent('toString')).toBe('sync');
    expect(classifyRevenueCatEvent('')).toBe('sync');
  });

  it('appUserIdsToSync returns the single uuid for sync events, both sides for TRANSFER, nothing for ignore, and drops anonymous ids', () => {
    const base = { id: 'evt_1', event_timestamp_ms: 1 } as const;
    expect(appUserIdsToSync({ ...base, type: 'RENEWAL', app_user_id: USER })).toEqual([USER]);
    // 大文字の UUID も同じ利用者 (小文字に直す)
    expect(appUserIdsToSync({ ...base, type: 'RENEWAL', app_user_id: USER.toUpperCase() })).toEqual([USER]);
    // 匿名 ID・空・無いときは取り直さない
    expect(appUserIdsToSync({ ...base, type: 'RENEWAL', app_user_id: '$RCAnonymousID:abcdef0123456789' })).toEqual([]);
    expect(appUserIdsToSync({ ...base, type: 'INITIAL_PURCHASE' })).toEqual([]);
    // TRANSFER は移動元と移動先の全員 (重複なし・匿名を除く)
    expect(
      appUserIdsToSync({
        ...base,
        type: 'TRANSFER',
        app_user_id: OTHER_USER,
        transferred_from: [USER, '$RCAnonymousID:x'],
        transferred_to: [OTHER_USER, USER],
      }),
    ).toEqual([USER, OTHER_USER]);
    // ignore の種類は app_user_id があっても空
    expect(appUserIdsToSync({ ...base, type: 'TEST', app_user_id: USER })).toEqual([]);
    expect(appUserIdsToSync({ ...base, type: 'INVOICE_ISSUANCE', app_user_id: USER })).toEqual([]);
  });
});

describe('billing/03 §7.3 deriveStoreStatus / projectStoreSubscription', () => {
  it('deriveStoreStatus follows §7.3: refunded → cancelled, no expiry → active, future expiry → past_due / trialing / active, past expiry with a future grace_period_expires_date → past_due, past expiry without grace (null or past) → expired', () => {
    expect(deriveStoreStatus(sub({ refunded_at: PAST }), NOW_MS)).toBe('cancelled');
    // 返金は期限より先に見る
    expect(deriveStoreStatus(sub({ refunded_at: PAST, expires_date: FUTURE, period_type: 'trial' }), NOW_MS)).toBe('cancelled');
    expect(deriveStoreStatus(sub({ expires_date: null }), NOW_MS)).toBe('active');
    expect(deriveStoreStatus(sub({ expires_date: FUTURE, billing_issues_detected_at: PAST }), NOW_MS)).toBe('past_due');
    expect(deriveStoreStatus(sub({ expires_date: FUTURE, period_type: 'trial' }), NOW_MS)).toBe('trialing');
    expect(deriveStoreStatus(sub({ expires_date: FUTURE, period_type: 'TRIAL' }), NOW_MS)).toBe('trialing');
    expect(deriveStoreStatus(sub({ expires_date: FUTURE, period_type: 'intro' }), NOW_MS)).toBe('active');
    expect(deriveStoreStatus(sub({ expires_date: FUTURE, period_type: 'normal' }), NOW_MS)).toBe('active');
    expect(deriveStoreStatus(sub({ expires_date: PAST, grace_period_expires_date: FUTURE }), NOW_MS)).toBe('past_due');
    expect(deriveStoreStatus(sub({ expires_date: PAST, grace_period_expires_date: null }), NOW_MS)).toBe('expired');
    expect(deriveStoreStatus(sub({ expires_date: PAST, grace_period_expires_date: PAST }), NOW_MS)).toBe('expired');
    // ちょうど今の期限は過ぎたものとして扱う
    expect(deriveStoreStatus(sub({ expires_date: new Date(NOW_MS).toISOString() }), NOW_MS)).toBe('expired');
  });

  it('projectStoreSubscription builds the snapshot with plan_key and interval from the mapping and cancel_at_period_end from unsubscribe_detected_at', () => {
    const snapshot = projectStoreSubscription({
      userId: USER,
      store: 'app_store',
      productId: 'homegohan_pro_month',
      sub: sub({ unsubscribe_detected_at: PAST, is_sandbox: true, store_transaction_id: 2000000000000099 }),
      mapping: PRO_MONTH,
      supersededAt: null,
      nowMs: NOW_MS,
    });
    expect(snapshot).toEqual({
      user_id: USER,
      iap_store: 'app_store',
      iap_product_id: 'homegohan_pro_month',
      plan_key: 'pro',
      billing_interval: 'month',
      iap_status: 'active',
      is_sandbox: true,
      purchase_date: '2026-10-14T00:00:00.000Z',
      original_purchase_date: '2026-10-14T00:00:00.000Z',
      expires_date: FUTURE,
      cancel_at_period_end: true,
      refunded_at: null,
      store_transaction_id: '2000000000000099',
    });
    // 対応の行が無ければ plan_key と間隔は null (SQL が既存の行の plan_key を使う)
    const unmapped = projectStoreSubscription({
      userId: USER, store: 'app_store', productId: 'old', sub: sub({ is_sandbox: undefined, store_transaction_id: null }), mapping: null, supersededAt: null, nowMs: NOW_MS,
    });
    expect(unmapped).toMatchObject({ plan_key: null, billing_interval: null, is_sandbox: false, cancel_at_period_end: false, store_transaction_id: null });
    // 期限切れの購読は、自動更新を止めていても cancel_at_period_end を立てない
    expect(
      projectStoreSubscription({ userId: USER, store: 'app_store', productId: 'p', sub: sub({ expires_date: PAST, unsubscribe_detected_at: PAST }), mapping: PRO_MONTH, supersededAt: null, nowMs: NOW_MS }),
    ).toMatchObject({ iap_status: 'expired', cancel_at_period_end: false });
  });

  it('deriveStoreStatus / projectStoreSubscription keep past_due with cancel_at_period_end = true for an unsubscribed billing-issue subscription, and false after uncancellation', () => {
    const unsubscribed = sub({ billing_issues_detected_at: PAST, unsubscribe_detected_at: PAST });
    expect(deriveStoreStatus(unsubscribed, NOW_MS)).toBe('past_due');
    expect(
      projectStoreSubscription({ userId: USER, store: 'app_store', productId: 'homegohan_pro_month', sub: unsubscribed, mapping: PRO_MONTH, supersededAt: null, nowMs: NOW_MS }),
    ).toMatchObject({ iap_status: 'past_due', cancel_at_period_end: true });
    const uncancelled = sub({ billing_issues_detected_at: PAST, unsubscribe_detected_at: null });
    expect(
      projectStoreSubscription({ userId: USER, store: 'app_store', productId: 'homegohan_pro_month', sub: uncancelled, mapping: PRO_MONTH, supersededAt: null, nowMs: NOW_MS }),
    ).toMatchObject({ iap_status: 'past_due', cancel_at_period_end: false });
    // 猶予の間 (期限は過ぎた) に自動更新を止めても past_due のまま
    const graceUnsubscribed = sub({ expires_date: PAST, grace_period_expires_date: FUTURE, unsubscribe_detected_at: PAST });
    expect(
      projectStoreSubscription({ userId: USER, store: 'app_store', productId: 'homegohan_pro_month', sub: graceUnsubscribed, mapping: PRO_MONTH, supersededAt: null, nowMs: NOW_MS }),
    ).toMatchObject({ iap_status: 'past_due', cancel_at_period_end: true });
  });

  it('projectMissingSubscription builds an expired snapshot with expires_date = now and keeps the given is_sandbox and billing_interval', () => {
    for (const [isSandbox, billingInterval] of [[true, 'year'], [false, null]] as const) {
      expect(
        projectMissingSubscription({
          userId: USER, store: 'play_store', productId: 'homegohan_pro:monthly-autorenewing', planKey: 'pro',
          purchaseDate: '2026-09-01T00:00:00.000Z', isSandbox, billingInterval, nowMs: NOW_MS,
        }),
      ).toEqual({
        user_id: USER,
        iap_store: 'play_store',
        iap_product_id: 'homegohan_pro:monthly-autorenewing',
        plan_key: 'pro',
        billing_interval: billingInterval,
        iap_status: 'expired',
        is_sandbox: isSandbox,
        purchase_date: '2026-09-01T00:00:00.000Z',
        original_purchase_date: null,
        expires_date: '2026-10-21T00:00:00.000Z',
        cancel_at_period_end: false,
        refunded_at: null,
        store_transaction_id: null,
      });
    }
  });

  it('projectStoreSubscription maps each of the 12 product rows of §17.2 (6 products × app_store / play_store) to its plan_key and billing_interval', () => {
    // §17.2 の 12 行 (リテラル)
    const rows: PlanStoreProductRow[] = [
      { plan_key: 'pro', store: 'app_store', billing_interval: 'month', product_id: 'homegohan_pro_month', offered: true },
      { plan_key: 'pro', store: 'app_store', billing_interval: 'year', product_id: 'homegohan_pro_year', offered: true },
      { plan_key: 'family_basic', store: 'app_store', billing_interval: 'month', product_id: 'homegohan_family_basic_month', offered: true },
      { plan_key: 'family_basic', store: 'app_store', billing_interval: 'year', product_id: 'homegohan_family_basic_year', offered: true },
      { plan_key: 'family_pro', store: 'app_store', billing_interval: 'month', product_id: 'homegohan_family_pro_month', offered: true },
      { plan_key: 'family_pro', store: 'app_store', billing_interval: 'year', product_id: 'homegohan_family_pro_year', offered: true },
      { plan_key: 'pro', store: 'play_store', billing_interval: 'month', product_id: 'homegohan_pro:monthly-autorenewing', offered: true },
      { plan_key: 'pro', store: 'play_store', billing_interval: 'year', product_id: 'homegohan_pro:annual-autorenewing', offered: true },
      { plan_key: 'family_basic', store: 'play_store', billing_interval: 'month', product_id: 'homegohan_family_basic:monthly-autorenewing', offered: true },
      { plan_key: 'family_basic', store: 'play_store', billing_interval: 'year', product_id: 'homegohan_family_basic:annual-autorenewing', offered: true },
      { plan_key: 'family_pro', store: 'play_store', billing_interval: 'month', product_id: 'homegohan_family_pro:monthly-autorenewing', offered: true },
      { plan_key: 'family_pro', store: 'play_store', billing_interval: 'year', product_id: 'homegohan_family_pro:annual-autorenewing', offered: true },
    ];
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      // 1 つずつ取り直しに入れて、selectStoreSubscriptions → projectStoreSubscription で写す
      const [entry] = selectStoreSubscriptions(info({ [row.product_id]: sub({ store: row.store }) }), rows, NOW_MS);
      expect(entry.mapping, row.product_id).toEqual(row);
      expect(
        projectStoreSubscription({ userId: USER, store: entry.store, productId: entry.productId, sub: entry.sub, mapping: entry.mapping, supersededAt: entry.supersededAt, nowMs: NOW_MS }),
        row.product_id,
      ).toMatchObject({ iap_store: row.store, iap_product_id: row.product_id, plan_key: row.plan_key, billing_interval: row.billing_interval });
    }
  });
});

describe('billing/03 §8.1 selectStoreSubscriptions (適用の順と、同じグループの 2 つの live)', () => {
  it('selectStoreSubscriptions keeps only app_store / play_store entries and orders non-live before live, then by expires_date', () => {
    const selected = selectStoreSubscriptions(
      info({
        live_late: sub({ expires_date: '2026-12-21T00:00:00.000Z', store: 'play_store' }),
        expired_late: sub({ expires_date: '2026-10-10T00:00:00.000Z' }),
        promo: sub({ store: 'promotional' }),
        stripe: sub({ store: 'stripe' }),
        expired_early: sub({ expires_date: '2026-09-10T00:00:00.000Z', store: 'APP_STORE' }),
      }),
      [PRO_MONTH],
      NOW_MS,
    );
    expect(selected.map((entry) => entry.productId)).toEqual(['expired_early', 'expired_late', 'live_late']);
    expect(selected.map((entry) => entry.store)).toEqual(['app_store', 'app_store', 'play_store']);
    expect(selected.every((entry) => entry.supersededAt === null)).toBe(true);
    // 対応の行は (store, product_id) で引く
    expect(selectStoreSubscriptions(info({ homegohan_pro_month: sub() }), [PRO_MONTH], NOW_MS)[0].mapping).toEqual(PRO_MONTH);
    expect(selectStoreSubscriptions(info({ homegohan_pro_month: sub({ store: 'play_store' }) }), [PRO_MONTH], NOW_MS)[0].mapping).toBeNull();
  });

  it('selectStoreSubscriptions marks every live app_store entry except the most recent by compareStoreSubscriptionRecency (purchase_date, then expires_date, then product_id) as superseded with supersededAt = the winner purchase_date and orders them before the winner, leaves a single live app_store entry and non-live entries with supersededAt null, and never supersedes two live play_store entries', () => {
    // 体験中の個人 Pro の月額と、purchase_date の新しい家族 Pro の月額 (上位への変更。S36)
    const trialPro = sub({ period_type: 'trial', purchase_date: '2026-10-15T00:00:00.000Z', expires_date: '2026-10-22T00:00:00.000Z' });
    const familyPro = sub({ purchase_date: '2026-10-18T00:00:00.000Z', expires_date: '2026-11-18T00:00:00.000Z' });
    const expired = sub({ expires_date: PAST });
    const selected = selectStoreSubscriptions(
      info({ homegohan_pro_month: trialPro, homegohan_family_pro_month: familyPro, homegohan_pro_year: expired }),
      [PRO_MONTH],
      NOW_MS,
    );
    expect(selected.map((entry) => [entry.productId, entry.supersededAt])).toEqual([
      ['homegohan_pro_year', null],
      ['homegohan_pro_month', '2026-10-18T00:00:00.000Z'],
      ['homegohan_family_pro_month', null],
    ]);
    // 同じ purchase_date: expires_date の遅い方が新しい (無い = 期限なしを最も遅い)
    const tieA = sub({ purchase_date: '2026-10-18T00:00:00.000Z', expires_date: '2026-11-18T00:00:00.000Z' });
    const tieB = sub({ purchase_date: '2026-10-18T00:00:00.000Z', expires_date: '2027-10-18T00:00:00.000Z' });
    expect(compareStoreSubscriptionRecency({ productId: 'a', sub: tieA }, { productId: 'b', sub: tieB })).toBeLessThan(0);
    expect(compareStoreSubscriptionRecency({ productId: 'b', sub: tieB }, { productId: 'a', sub: tieA })).toBeGreaterThan(0);
    expect(compareStoreSubscriptionRecency({ productId: 'a', sub: tieA }, { productId: 'b', sub: { ...tieA, expires_date: null } })).toBeLessThan(0);
    // それも同じなら product_id の辞書順で後ろの方
    expect(compareStoreSubscriptionRecency({ productId: 'a', sub: tieA }, { productId: 'b', sub: tieA })).toBeLessThan(0);
    expect(compareStoreSubscriptionRecency({ productId: 'b', sub: tieA }, { productId: 'a', sub: tieA })).toBeGreaterThan(0);
    expect(compareStoreSubscriptionRecency({ productId: 'a', sub: tieA }, { productId: 'a', sub: tieA })).toBe(0);
    const tied = selectStoreSubscriptions(info({ a_product: tieA, b_product: tieA }), [], NOW_MS);
    expect(tied.map((entry) => [entry.productId, entry.supersededAt])).toEqual([
      ['a_product', '2026-10-18T00:00:00.000Z'],
      ['b_product', null],
    ]);
    // live な App Store の購読が 1 つだけなら置き換えない
    expect(selectStoreSubscriptions(info({ homegohan_pro_month: trialPro }), [PRO_MONTH], NOW_MS)[0].supersededAt).toBeNull();
    // Google Play の 2 つの live は置き換えない (二重購読。写像の 5. が BILL_LIVE_ROW_CONFLICT。S25)
    const play = selectStoreSubscriptions(
      info({ 'homegohan_pro:monthly-autorenewing': sub({ store: 'play_store' }), 'homegohan_family_pro:monthly-autorenewing': sub({ store: 'play_store', purchase_date: '2026-10-18T00:00:00.000Z' }) }),
      [],
      NOW_MS,
    );
    expect(play.every((entry) => entry.supersededAt === null)).toBe(true);
  });

  it('projectStoreSubscription turns an entry with supersededAt into an expired snapshot whose expires_date is supersededAt and cancel_at_period_end is false even with unsubscribe_detected_at, and unmappedStoreSubscriptionDecision skips a superseded live entry that has neither a mapping nor a user row', () => {
    const live = sub({ period_type: 'trial', unsubscribe_detected_at: PAST });
    expect(
      projectStoreSubscription({ userId: USER, store: 'app_store', productId: 'homegohan_pro_month', sub: live, mapping: PRO_MONTH, supersededAt: '2026-10-18T00:00:00.000Z', nowMs: NOW_MS }),
    ).toMatchObject({ iap_status: 'expired', expires_date: '2026-10-18T00:00:00.000Z', cancel_at_period_end: false, plan_key: 'pro' });
    expect(unmappedStoreSubscriptionDecision({ sub: live, mapping: null, supersededAt: '2026-10-18T00:00:00.000Z' }, false, NOW_MS)).toBe('skip');
    // 利用者の行があれば置き換えられた購読も写す (expired の snapshot で終わらせる)
    expect(unmappedStoreSubscriptionDecision({ sub: live, mapping: null, supersededAt: '2026-10-18T00:00:00.000Z' }, true, NOW_MS)).toBe('apply');
  });

  it('unmappedStoreSubscriptionDecision applies mapped entries and unmapped entries with an existing row, rejects unmapped live entries without a row and skips unmapped non-live entries without a row', () => {
    expect(unmappedStoreSubscriptionDecision({ sub: sub(), mapping: PRO_MONTH, supersededAt: null }, false, NOW_MS)).toBe('apply');
    expect(unmappedStoreSubscriptionDecision({ sub: sub({ expires_date: PAST }), mapping: PRO_MONTH, supersededAt: null }, false, NOW_MS)).toBe('apply');
    expect(unmappedStoreSubscriptionDecision({ sub: sub(), mapping: null, supersededAt: null }, true, NOW_MS)).toBe('apply');
    for (const live of [sub(), sub({ period_type: 'trial' }), sub({ billing_issues_detected_at: PAST }), sub({ expires_date: PAST, grace_period_expires_date: FUTURE })]) {
      expect(unmappedStoreSubscriptionDecision({ sub: live, mapping: null, supersededAt: null }, false, NOW_MS)).toBe('reject');
    }
    for (const notLive of [sub({ expires_date: PAST }), sub({ refunded_at: PAST })]) {
      expect(unmappedStoreSubscriptionDecision({ sub: notLive, mapping: null, supersededAt: null }, false, NOW_MS)).toBe('skip');
    }
  });
});

describe('billing/03 §8.1 needsLazyResync・minimizeRevenueCatEventPayload・buildIapCatalog', () => {
  it('needsLazyResync is true only for store rows past current_period_end whose iap_synced_at is older than 5 minutes', () => {
    expect(IAP_LAZY_RESYNC_MIN_INTERVAL_MS).toBe(5 * 60 * 1000);
    const fiveMinutesAgo = new Date(NOW_MS - 5 * 60 * 1000).toISOString();
    const fourMinutesAgo = new Date(NOW_MS - 4 * 60 * 1000).toISOString();
    expect(needsLazyResync(null, NOW_MS)).toBe(false);
    expect(needsLazyResync({ iap_store: null, current_period_end: PAST, iap_synced_at: null }, NOW_MS)).toBe(false);
    expect(needsLazyResync({ iap_store: 'app_store', current_period_end: FUTURE, iap_synced_at: null }, NOW_MS)).toBe(false);
    expect(needsLazyResync({ iap_store: 'app_store', current_period_end: null, iap_synced_at: null }, NOW_MS)).toBe(false);
    expect(needsLazyResync({ iap_store: 'app_store', current_period_end: PAST, iap_synced_at: null }, NOW_MS)).toBe(true);
    expect(needsLazyResync({ iap_store: 'play_store', current_period_end: PAST, iap_synced_at: fiveMinutesAgo }, NOW_MS)).toBe(true);
    expect(needsLazyResync({ iap_store: 'play_store', current_period_end: PAST, iap_synced_at: fourMinutesAgo }, NOW_MS)).toBe(false);
  });

  it('minimizeRevenueCatEventPayload keeps only the allow-listed fields and drops subscriber_attributes / aliases / price', () => {
    const envelope = RevenueCatWebhookEnvelopeSchema.parse({
      api_version: '1.0',
      event: {
        id: 'evt_1',
        type: 'INITIAL_PURCHASE',
        event_timestamp_ms: 1_760_000_000_000,
        app_user_id: USER,
        original_app_user_id: USER,
        aliases: [USER, '$RCAnonymousID:x'],
        product_id: 'homegohan_pro_month',
        store: 'APP_STORE',
        environment: 'SANDBOX',
        price: 580,
        currency: 'JPY',
        country_code: 'JP',
        subscriber_attributes: { $email: { value: 'person@example.com', updated_at_ms: 1 } },
      },
    });
    const stored = minimizeRevenueCatEventPayload(envelope);
    expect(stored).toEqual({
      id: 'evt_1',
      type: 'INITIAL_PURCHASE',
      api_version: '1.0',
      event_timestamp_ms: 1_760_000_000_000,
      app_user_id: USER,
      original_app_user_id: USER,
      product_id: 'homegohan_pro_month',
      store: 'APP_STORE',
      environment: 'SANDBOX',
      transferred_from: null,
      transferred_to: null,
    });
    const json = JSON.stringify(stored);
    for (const dropped of ['person@example.com', 'aliases', 'price', 'JPY', 'country_code', 'subscriber_attributes']) {
      expect(json, dropped).not.toContain(dropped);
    }
  });

  it('buildIapCatalog returns only plans that have offered products for the store, month before year, ignores offered = false rows and returns no trial days', () => {
    const plans = [
      { plan_key: 'pro', display_name: '個人 Pro', max_members: null },
      { plan_key: 'family_basic', display_name: '家族 Basic', max_members: 4 },
      { plan_key: 'family_pro', display_name: '家族 Pro', max_members: 8 },
    ];
    const products: PlanStoreProductRow[] = [
      { plan_key: 'pro', store: 'app_store', billing_interval: 'year', product_id: 'homegohan_pro_year', offered: true },
      { plan_key: 'pro', store: 'app_store', billing_interval: 'month', product_id: 'homegohan_pro_month', offered: true },
      { plan_key: 'pro', store: 'app_store', billing_interval: 'month', product_id: 'homegohan_pro_month_old', offered: false },
      { plan_key: 'family_basic', store: 'play_store', billing_interval: 'month', product_id: 'homegohan_family_basic:monthly-autorenewing', offered: true },
      { plan_key: 'family_pro', store: 'app_store', billing_interval: 'month', product_id: 'homegohan_family_pro_month_old', offered: false },
    ];
    const catalog = buildIapCatalog('app_store', plans, products);
    expect(catalog).toEqual({
      store: 'app_store',
      plans: [
        {
          plan_key: 'pro',
          display_name: '個人 Pro',
          max_members: null,
          products: [
            { billing_interval: 'month', product_id: 'homegohan_pro_month' },
            { billing_interval: 'year', product_id: 'homegohan_pro_year' },
          ],
        },
      ],
    });
    expect(JSON.stringify(catalog)).not.toMatch(/trial/);
    expect(buildIapCatalog('play_store', plans, products).plans.map((plan) => plan.plan_key)).toEqual(['family_basic']);
    expect(buildIapCatalog('play_store', plans, []).plans).toEqual([]);
  });
});

describe('billing/03 §8.1 RevenueCat のオブジェクト (Zod)', () => {
  it('RevenueCatWebhookEnvelopeSchema accepts the documented INITIAL_PURCHASE / RENEWAL / TRANSFER samples and rejects a body without event.id', () => {
    // RevenueCat の sample events (P4) の形 (本冊が読む項目と、読まない項目 (知らない項目は捨てずに通す))
    const samples = [
      {
        api_version: '1.0',
        event: {
          id: 'CD489E0E-5D52-4E03-966B-A7F17788E432',
          type: 'INITIAL_PURCHASE',
          app_id: 'app1234567890',
          event_timestamp_ms: 1658726378679,
          app_user_id: USER,
          original_app_user_id: USER,
          aliases: [USER],
          product_id: 'homegohan_pro_month',
          entitlement_ids: ['pro'],
          period_type: 'TRIAL',
          purchased_at_ms: 1658726374000,
          expiration_at_ms: 1659331174000,
          store: 'APP_STORE',
          environment: 'SANDBOX',
          is_family_share: false,
          country_code: 'JP',
          currency: 'JPY',
          price: 0,
          subscriber_attributes: {},
          transaction_id: '170000869511114',
          original_transaction_id: '170000869511114',
        },
      },
      {
        api_version: '1.0',
        event: {
          id: '9D2D2F3E-1C2B-4C61-9B6B-27A2E5F1A100',
          type: 'RENEWAL',
          event_timestamp_ms: 1661404774000,
          app_user_id: USER,
          product_id: 'homegohan_pro:monthly-autorenewing',
          store: 'PLAY_STORE',
          environment: 'PRODUCTION',
          entitlement_ids: null,
        },
      },
      {
        api_version: '1.0',
        event: {
          id: '9D2D2F3E-1C2B-4C61-9B6B-27A2E5F1A101',
          type: 'TRANSFER',
          event_timestamp_ms: 1661404774001,
          store: 'APP_STORE',
          environment: 'PRODUCTION',
          transferred_from: [USER],
          transferred_to: [OTHER_USER],
        },
      },
    ];
    for (const sample of samples) {
      const parsed = RevenueCatWebhookEnvelopeSchema.safeParse(sample);
      expect(parsed.success, sample.event.type).toBe(true);
    }
    const transfer = RevenueCatWebhookEnvelopeSchema.parse(samples[2]).event as RevenueCatEvent;
    expect(appUserIdsToSync(transfer)).toEqual([USER, OTHER_USER]);
    const withoutId = { api_version: '1.0', event: { type: 'RENEWAL', event_timestamp_ms: 1 } };
    expect(RevenueCatWebhookEnvelopeSchema.safeParse(withoutId).success).toBe(false);
    expect(RevenueCatWebhookEnvelopeSchema.safeParse({ api_version: '1.0', event: { id: '', type: 'RENEWAL', event_timestamp_ms: 1 } }).success).toBe(false);
    expect(RevenueCatWebhookEnvelopeSchema.safeParse({ event: { id: 'e', type: 'RENEWAL', event_timestamp_ms: 1 } }).success).toBe(false);
  });

  it('RevenueCatCustomerInfoSchema accepts the documented subscriber shape (subscriptions keyed by product id)', () => {
    const parsed = RevenueCatCustomerInfoSchema.safeParse({
      request_date: '2026-10-21T00:00:00Z',
      request_date_ms: 1_760_000_000_000,
      subscriber: {
        original_app_user_id: USER,
        first_seen: '2026-10-01T00:00:00Z',
        last_seen: '2026-10-21T00:00:00Z',
        management_url: 'https://apps.apple.com/account/subscriptions',
        entitlements: { pro: { expires_date: FUTURE, product_identifier: 'homegohan_pro_month', purchase_date: PAST } },
        non_subscriptions: {},
        subscriptions: {
          homegohan_pro_month: {
            expires_date: FUTURE,
            purchase_date: PAST,
            original_purchase_date: PAST,
            period_type: 'normal',
            store: 'app_store',
            is_sandbox: false,
            unsubscribe_detected_at: null,
            billing_issues_detected_at: null,
            grace_period_expires_date: null,
            auto_resume_date: null,
            refunded_at: null,
            store_transaction_id: '2000000000000001',
            ownership_type: 'PURCHASED',
          },
          'homegohan_pro:monthly-autorenewing': {
            expires_date: null,
            purchase_date: PAST,
            period_type: 'trial',
            store: 'play_store',
            store_transaction_id: 12345,
          },
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(Object.keys(parsed.data.subscriber.subscriptions)).toEqual(['homegohan_pro_month', 'homegohan_pro:monthly-autorenewing']);
    // subscriptions が無い・purchase_date が無い形は通さない
    expect(RevenueCatCustomerInfoSchema.safeParse({ request_date: 'x', subscriber: { original_app_user_id: USER } }).success).toBe(false);
    expect(
      RevenueCatCustomerInfoSchema.safeParse({
        request_date: 'x',
        subscriber: { original_app_user_id: USER, subscriptions: { p: { period_type: 'normal', store: 'app_store' } } },
      }).success,
    ).toBe(false);
  });
});

describe('billing/03 §13.1 文と共有の一覧', () => {
  it('IAP_ERROR_MESSAGES do not contain any UNFINISHED_WORDS (準備中 / 販売開始前 / 近日 / 予定 / まだ / 確定次第 / これから)', () => {
    expect(Object.keys(IAP_ERROR_MESSAGES).sort()).toEqual(
      ['BILL_IAP_INVALID_INPUT', 'BILL_IAP_SYNC_CONFLICT', 'BILL_IAP_UNKNOWN_PRODUCT', 'EXT_REVENUECAT_API_FAILED', 'EXT_REVENUECAT_NOT_CONFIGURED'].sort(),
    );
    for (const [code, message] of Object.entries(IAP_ERROR_MESSAGES)) {
      expect(message.length, code).toBeGreaterThan(0);
      for (const word of UNFINISHED_WORDS) expect(message, `${code} ${word}`).not.toContain(word);
    }
  });

  it('IAP_STORES equals PURCHASE_STORES of @homegohan/shared (billing-plans.ts)', () => {
    expect([...IAP_STORES]).toEqual([...PURCHASE_STORES]);
    expect([...IAP_STORES]).toEqual(['app_store', 'play_store']);
  });
});

/**
 * 課金の核の純粋な部分 (src/lib/billing/core.ts) の単体テスト (billing/01 §14.1 のテスト 1〜16・72・89・95・111・112)。
 * DB も Stripe も使わない。期待値は設計書の表をリテラルで書く (core.ts の定数から組み立てない)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BILLING_CANCEL_SCHEDULED_WITHOUT_DATE_TEXT,
  BILLING_ERROR_MESSAGES,
  EMPTY_PLAN_FEATURES,
  STRIPE_EVENT_ACTIONS,
  STRIPE_SUBSCRIBED_EVENT_TYPES,
  STRIPE_TO_DB_STATUS,
  StripeEventEnvelopeSchema,
  StripeSubscriptionSchema,
  billingStatusLines,
  buildCheckoutSessionParams,
  checkoutReturnUrls,
  classifyStripeEvent,
  formatBillingDate,
  invoiceSubscriptionId,
  isPurchasable,
  isStripeEventClaim,
  isTerminalStripeStatus,
  minimizeStripeEventPayload,
  projectSubscription,
  resolvePlanKey,
  stripeKeyMode,
  summarizeSubscription,
  toFormBody,
  trialDaysFor,
  type BillingSummary,
  type PlanFeatures,
  type PurchasablePlan,
  type StripeEventEnvelope,
  type StripeSubscription,
  type SubscriptionRowView,
} from '@/lib/billing/core';

const SITE = 'https://example.test';
const USER = '11111111-1111-4111-8111-111111111111';

/** Stripe の Subscription の最小の形 (Zod を通して作る) */
function subscription(overrides: Record<string, unknown> = {}): StripeSubscription {
  return StripeSubscriptionSchema.parse({
    id: 'sub_1',
    object: 'subscription',
    customer: 'cus_1',
    status: 'trialing',
    metadata: { user_id: USER, plan_key: 'pro', interval: 'month' },
    items: { data: [{ id: 'si_1', price: { id: 'price_month', recurring: { interval: 'month' } } }] },
    start_date: 1_760_000_000,
    current_period_start: 1_760_000_000,
    current_period_end: 1_760_604_800,
    trial_start: 1_760_000_000,
    trial_end: 1_760_604_800,
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    pause_collection: null,
    ...overrides,
  });
}

function plan(overrides: Partial<PurchasablePlan> = {}): PurchasablePlan {
  return {
    plan_key: 'pro',
    display_name: 'Pro',
    plan_type: 'personal',
    status: 'public',
    monthly_price_jpy: 980,
    yearly_price_jpy: 9800,
    trial_days: 7,
    stripe_price_id: 'price_month',
    stripe_yearly_price_id: 'price_year',
    ...overrides,
  };
}

function row(overrides: Partial<SubscriptionRowView> = {}): SubscriptionRowView {
  return {
    id: 'row-1',
    plan_key: 'pro',
    status: 'active',
    stripe_subscription_id: 'sub_1',
    billing_interval: 'month',
    current_period_end: '2026-11-20T15:00:00.000Z',
    trial_ends_at: null,
    cancel_at_period_end: false,
    cancel_at: null,
    iap_store: null,
    iap_synced_at: null,
    ...overrides,
  };
}

function event(type: string, object: Record<string, unknown>): StripeEventEnvelope {
  return StripeEventEnvelopeSchema.parse({ id: 'evt_1', object: 'event', type, created: 1_760_000_000, livemode: false, data: { object } });
}

describe('billing core: status の写像とイベントの振り分け', () => {
  it('STRIPE_TO_DB_STATUS maps all 8 Stripe statuses and matches §6.4', () => {
    // §6.4 の CASE と同じ 8 組 (テスト 53 と同じ組をリテラルで持つ。§8.2)
    expect(STRIPE_TO_DB_STATUS).toEqual({
      incomplete: 'incomplete',
      incomplete_expired: 'expired',
      trialing: 'trialing',
      active: 'active',
      past_due: 'past_due',
      unpaid: 'past_due',
      canceled: 'cancelled',
      paused: 'expired',
    });
    expect(Object.keys(STRIPE_TO_DB_STATUS)).toHaveLength(8);
  });

  it('classifyStripeEvent returns ignore for unknown types and the table for subscribed types', () => {
    expect(classifyStripeEvent('checkout.session.completed')).toBe('sync_checkout_session');
    for (const type of [
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'customer.subscription.paused',
      'customer.subscription.resumed',
      'customer.subscription.trial_will_end',
      'customer.subscription.pending_update_applied',
      'customer.subscription.pending_update_expired',
    ]) {
      expect(classifyStripeEvent(type), type).toBe('sync_subscription');
    }
    expect(classifyStripeEvent('invoice.paid')).toBe('sync_invoice_subscription');
    expect(classifyStripeEvent('invoice.payment_action_required')).toBe('sync_invoice_subscription');
    expect(classifyStripeEvent('invoice.payment_failed')).toBe('audit_payment_failed_and_sync');
    for (const type of ['customer.updated', 'payment_method.attached', 'charge.dispute.created', 'toString', '__proto__', 'constructor', '']) {
      expect(classifyStripeEvent(type), type).toBe('ignore');
    }
  });

  it('STRIPE_SUBSCRIBED_EVENT_TYPES lists exactly the keys of STRIPE_EVENT_ACTIONS', () => {
    expect([...STRIPE_SUBSCRIBED_EVENT_TYPES]).toEqual(Object.keys(STRIPE_EVENT_ACTIONS));
    // Dashboard に登録する 12 種 (§17.1 の 2.)
    expect(STRIPE_SUBSCRIBED_EVENT_TYPES).toHaveLength(12);
    expect(new Set(STRIPE_SUBSCRIBED_EVENT_TYPES).size).toBe(12);
  });
});

describe('billing core: Subscription → snapshot', () => {
  it('projectSubscription converts unix seconds to ISO and reads price/interval/metadata', () => {
    const snapshot = projectSubscription(
      subscription({ status: 'active', cancel_at: 1_760_604_800, cancel_at_period_end: true, canceled_at: 1_760_100_000, pause_collection: { behavior: 'void' } }),
      'pro',
    );
    expect(snapshot).toEqual({
      stripe_subscription_id: 'sub_1',
      stripe_customer_id: 'cus_1',
      user_id: USER,
      plan_key: 'pro',
      stripe_price_id: 'price_month',
      billing_interval: 'month',
      stripe_status: 'active',
      pause_collection: true,
      start_date: '2025-10-09T08:53:20.000Z',
      current_period_start: '2025-10-09T08:53:20.000Z',
      current_period_end: '2025-10-16T08:53:20.000Z',
      trial_start: '2025-10-09T08:53:20.000Z',
      trial_end: '2025-10-16T08:53:20.000Z',
      cancel_at: '2025-10-16T08:53:20.000Z',
      cancel_at_period_end: true,
      canceled_at: '2025-10-10T12:40:00.000Z',
      ended_at: null,
    });
    // 年額の Price
    const yearly = projectSubscription(
      subscription({ items: { data: [{ id: 'si_2', price: { id: 'price_year', recurring: { interval: 'year' } } }] } }),
      'pro',
    );
    expect(yearly).toMatchObject({ stripe_price_id: 'price_year', billing_interval: 'year' });
    // 月・年以外の間隔は null
    const weekly = projectSubscription(
      subscription({ items: { data: [{ id: 'si_3', price: { id: 'price_week', recurring: { interval: 'week' } } }] } }),
      'pro',
    );
    expect(weekly).toMatchObject({ stripe_price_id: 'price_week', billing_interval: null });
  });

  it('projectSubscription leaves user_id/plan_key null when metadata is empty', () => {
    expect(projectSubscription(subscription({ metadata: {} }), null)).toMatchObject({ user_id: null, plan_key: null });
    expect(projectSubscription(subscription({ metadata: null }), null)).toMatchObject({ user_id: null, plan_key: null });
    expect(projectSubscription(subscription({ metadata: { user_id: '' } }), null)).toMatchObject({ user_id: null });
    // items が空なら Price も間隔も null
    expect(projectSubscription(subscription({ items: { data: [] } }), null)).toMatchObject({ stripe_price_id: null, billing_interval: null });
  });

  it('resolvePlanKey prefers metadata.plan_key over the price lookup', () => {
    expect(resolvePlanKey(subscription({ metadata: { plan_key: 'family_basic' } }), 'pro')).toBe('family_basic');
    expect(resolvePlanKey(subscription({ metadata: { plan_key: '' } }), 'pro')).toBe('pro');
    expect(resolvePlanKey(subscription({ metadata: {} }), 'pro')).toBe('pro');
    expect(resolvePlanKey(subscription({ metadata: null }), null)).toBeNull();
  });

  it('invoiceSubscriptionId reads acacia (top-level) and basil (parent) shapes and expanded objects', () => {
    expect(invoiceSubscriptionId({ id: 'in_1', object: 'invoice', subscription: 'sub_a' })).toBe('sub_a');
    expect(invoiceSubscriptionId({ id: 'in_1', object: 'invoice', subscription: { id: 'sub_b' } })).toBe('sub_b');
    expect(invoiceSubscriptionId({ id: 'in_1', object: 'invoice', parent: { subscription_details: { subscription: 'sub_c' } } })).toBe('sub_c');
    expect(invoiceSubscriptionId({ id: 'in_1', object: 'invoice', parent: { subscription_details: { subscription: { id: 'sub_d' } } } })).toBe(
      'sub_d',
    );
    expect(invoiceSubscriptionId({ id: 'in_1', object: 'invoice' })).toBeNull();
    expect(invoiceSubscriptionId({ id: 'in_1', object: 'invoice', subscription: null, parent: null })).toBeNull();
  });
});

describe('billing core: プラン', () => {
  it('isPurchasable rejects free, draft, org, missing price, zero amount', () => {
    expect(isPurchasable(plan(), 'month')).toBe(true);
    expect(isPurchasable(plan(), 'year')).toBe(true);
    expect(isPurchasable(plan({ plan_type: 'family', plan_key: 'family_basic' }), 'month')).toBe(true);
    expect(isPurchasable(plan({ plan_key: 'free' }), 'month')).toBe(false);
    expect(isPurchasable(plan({ status: 'draft' }), 'month')).toBe(false);
    expect(isPurchasable(plan({ status: 'private' }), 'month')).toBe(false);
    expect(isPurchasable(plan({ plan_type: 'organization' }), 'month')).toBe(false);
    expect(isPurchasable(plan({ stripe_price_id: null }), 'month')).toBe(false);
    expect(isPurchasable(plan({ stripe_price_id: null }), 'year')).toBe(true);
    expect(isPurchasable(plan({ stripe_yearly_price_id: null }), 'year')).toBe(false);
    expect(isPurchasable(plan({ monthly_price_jpy: 0 }), 'month')).toBe(false);
    expect(isPurchasable(plan({ monthly_price_jpy: null }), 'month')).toBe(false);
    expect(isPurchasable(plan({ yearly_price_jpy: -1 }), 'year')).toBe(false);
  });

  it('trialDaysFor returns 0 when the trial was already used', () => {
    expect(trialDaysFor(7, false)).toBe(7);
    expect(trialDaysFor(7, true)).toBe(0);
    expect(trialDaysFor(0, false)).toBe(0);
    expect(trialDaysFor(-3, false)).toBe(0);
  });
});

describe('billing core: Checkout のパラメータ', () => {
  const input = { customerId: 'cus_1', userId: USER, planKey: 'pro', interval: 'month' as const, priceId: 'price_month', siteUrl: SITE };

  it('buildCheckoutSessionParams omits trial_period_days when trialDays is 0', () => {
    const withTrial = buildCheckoutSessionParams({ ...input, trialDays: 7 });
    expect(withTrial.subscription_data).toEqual({ metadata: { user_id: USER, plan_key: 'pro', interval: 'month' }, trial_period_days: 7 });
    const withoutTrial = buildCheckoutSessionParams({ ...input, trialDays: 0 });
    expect(withoutTrial.subscription_data).toEqual({ metadata: { user_id: USER, plan_key: 'pro', interval: 'month' } });
    expect(toFormBody(withoutTrial)).not.toContain('trial_period_days');
    expect(withTrial).toMatchObject({
      mode: 'subscription',
      customer: 'cus_1',
      client_reference_id: USER,
      line_items: [{ price: 'price_month', quantity: 1 }],
      locale: 'ja',
      payment_method_collection: 'always',
      metadata: { user_id: USER, plan_key: 'pro', interval: 'month' },
    });
  });

  it('checkoutReturnUrls keeps the {CHECKOUT_SESSION_ID} placeholder', () => {
    expect(checkoutReturnUrls(SITE)).toEqual({
      successUrl: `${SITE}/account/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${SITE}/account/billing?checkout=cancelled`,
    });
  });

  it('buildCheckoutSessionParams sets allow_promotion_codes=true and cancel_url to <site>/account/billing?checkout=cancelled', () => {
    const params = buildCheckoutSessionParams({ ...input, trialDays: 0 });
    expect(params.allow_promotion_codes).toBe(true);
    expect(params.cancel_url).toBe(`${SITE}/account/billing?checkout=cancelled`);
    expect(params.success_url).toBe(`${SITE}/account/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  });

  it('toFormBody encodes nested objects and arrays in Stripe form style and skips null/undefined', () => {
    const body = toFormBody({
      a: 'x y',
      n: 1,
      b: true,
      f: false,
      skipNull: null,
      skipUndefined: undefined,
      nested: { k: 'v', deep: { z: '&=' }, gone: null },
      list: [{ price: 'p', quantity: 1 }, 'plain'],
    });
    expect(body.split('&')).toEqual([
      'a=x%20y',
      'n=1',
      'b=true',
      'f=false',
      `${encodeURIComponent('nested[k]')}=v`,
      `${encodeURIComponent('nested[deep][z]')}=${encodeURIComponent('&=')}`,
      `${encodeURIComponent('list[0][price]')}=p`,
      `${encodeURIComponent('list[0][quantity]')}=1`,
      `${encodeURIComponent('list[1]')}=plain`,
    ]);
    expect(toFormBody({})).toBe('');
    // 空文字は送る (Stripe で「消す」の意味。匿名化に使う)
    expect(toFormBody({ name: '' })).toBe('name=');
  });

  it('stripeKeyMode reads sk_/rk_ live and test prefixes', () => {
    expect(stripeKeyMode('sk_live_abc')).toBe('live');
    expect(stripeKeyMode('rk_live_abc')).toBe('live');
    expect(stripeKeyMode('sk_test_abc')).toBe('test');
    expect(stripeKeyMode('rk_test_abc')).toBe('test');
    expect(stripeKeyMode('pk_live_abc')).toBeNull();
    expect(stripeKeyMode('whsec_abc')).toBeNull();
    expect(stripeKeyMode('xsk_live_abc')).toBeNull();
    expect(stripeKeyMode('')).toBeNull();
  });
});

describe('billing core: 契約の要約', () => {
  it('summarizeSubscription: no row → free/can_purchase, live row (paused included) → can_cancel, scheduled → can_resume, manual row → no cancel', () => {
    expect(summarizeSubscription(null, false, 'free', EMPTY_PLAN_FEATURES)).toEqual({
      plan_key: 'free',
      effective_plan_key: 'free',
      status: null,
      source: null,
      billing_interval: null,
      current_period_end: null,
      trial_ends_at: null,
      cancel_at_period_end: false,
      cancel_at: null,
      has_customer: false,
      can_purchase: true,
      can_cancel: false,
      can_resume: false,
      manage_in_store: null,
      features: { ai_daily_limit: null, ai_feature_caps: {} },
    });
    for (const status of ['trialing', 'active', 'past_due', 'grace', 'paused']) {
      const summary = summarizeSubscription(row({ status }), true, 'pro', EMPTY_PLAN_FEATURES);
      expect(summary, status).toMatchObject({ plan_key: 'pro', status, source: 'stripe', can_purchase: false, can_cancel: true, can_resume: false });
    }
    expect(summarizeSubscription(row({ cancel_at_period_end: true, cancel_at: '2026-11-20T15:00:00.000Z' }), true, 'pro', EMPTY_PLAN_FEATURES)).toMatchObject({
      can_cancel: false,
      can_resume: true,
      cancel_at_period_end: true,
      cancel_at: '2026-11-20T15:00:00.000Z',
    });
    expect(summarizeSubscription(row({ stripe_subscription_id: null }), false, 'pro', EMPTY_PLAN_FEATURES)).toMatchObject({
      source: 'manual',
      plan_key: 'pro',
      can_purchase: false,
      can_cancel: false,
      can_resume: false,
    });
    // live でない行 (cancelled / expired / incomplete) は free として買える
    for (const status of ['cancelled', 'expired', 'incomplete']) {
      expect(summarizeSubscription(row({ status }), true, 'free', EMPTY_PLAN_FEATURES), status).toMatchObject({
        plan_key: 'free',
        status,
        can_purchase: true,
        can_cancel: false,
        can_resume: false,
      });
    }
    // 知らない status は null として扱う
    expect(summarizeSubscription(row({ status: 'bogus' }), true, 'free', EMPTY_PLAN_FEATURES)).toMatchObject({ status: null, can_purchase: true });
    // 間隔は month / year だけ
    expect(summarizeSubscription(row({ billing_interval: 'week' }), true, 'pro', EMPTY_PLAN_FEATURES).billing_interval).toBeNull();
    // 効いているプラン (家族・組織) は get_effective_plan の値をそのまま
    expect(summarizeSubscription(null, false, 'family_basic', EMPTY_PLAN_FEATURES).effective_plan_key).toBe('family_basic');
  });

  it('summarizeSubscription on rows shaped like the read-back after a Portal reservation and its revocation: a stripe-backed row with status active / trialing / past_due / grace and cancel_at_period_end true with cancel_at set gives can_resume true and can_cancel false; the same row with cancel_at_period_end false and cancel_at null gives can_cancel true and can_resume false', () => {
    for (const status of ['active', 'trialing', 'past_due', 'grace']) {
      const reserved = summarizeSubscription(
        row({ status, cancel_at_period_end: true, cancel_at: '2026-11-20T15:00:00.000Z' }),
        true,
        'pro',
        EMPTY_PLAN_FEATURES,
      );
      expect(reserved, status).toMatchObject({ status, can_resume: true, can_cancel: false });
      const revoked = summarizeSubscription(row({ status, cancel_at_period_end: false, cancel_at: null }), true, 'pro', EMPTY_PLAN_FEATURES);
      expect(revoked, status).toMatchObject({ status, can_cancel: true, can_resume: false });
    }
  });
});

describe('billing/03 §8.6: ストアの契約の要約と features (テスト 34〜36)', () => {
  /** 未完成や予定を示す語 (billing/03 §14.1 の冒頭。発注者の指示「「まだできてません」みたいなのは書かないで」) */
  const UNFINISHED_WORDS = ['準備中', '販売開始前', '近日', '予定', 'まだ', '確定次第', 'これから'] as const;

  it('summarizeSubscription marks store rows with source and manage_in_store and never can_cancel / can_resume them', () => {
    for (const store of ['app_store', 'play_store'] as const) {
      for (const status of ['trialing', 'active', 'past_due']) {
        for (const cancelAtPeriodEnd of [false, true]) {
          const summary = summarizeSubscription(
            row({ status, stripe_subscription_id: null, iap_store: store, iap_synced_at: '2026-10-20T00:00:00.000Z', cancel_at_period_end: cancelAtPeriodEnd }),
            false,
            'pro',
            EMPTY_PLAN_FEATURES,
          );
          expect(summary, `${store}/${status}/${cancelAtPeriodEnd}`).toMatchObject({
            plan_key: 'pro',
            status,
            source: store,
            manage_in_store: store,
            can_purchase: false,
            can_cancel: false,
            can_resume: false,
          });
        }
      }
      // live でないストアの行: source はストア、管理の案内 (manage_in_store) は出さない
      for (const status of ['cancelled', 'expired']) {
        expect(
          summarizeSubscription(row({ status, stripe_subscription_id: null, iap_store: store }), false, 'free', EMPTY_PLAN_FEATURES),
          `${store}/${status}`,
        ).toMatchObject({ plan_key: 'free', source: store, manage_in_store: null, can_purchase: true, can_cancel: false, can_resume: false });
      }
    }
    // 知らないストアの値は手動付与と同じ扱い (ストアの案内を出さない)
    expect(summarizeSubscription(row({ stripe_subscription_id: null, iap_store: 'amazon' }), false, 'pro', EMPTY_PLAN_FEATURES)).toMatchObject({
      source: 'manual',
      manage_in_store: null,
    });
  });

  it('summarizeSubscription includes features and keeps the stripe / manual behaviour unchanged', () => {
    const features: PlanFeatures = {
      ai_daily_limit: 3,
      ai_feature_caps: { menu_generation_ultimate: 0, image_generation: 0, meal_image_auto: 0, menu_generation: 3 },
    };
    expect(summarizeSubscription(null, false, 'free', features)).toEqual({
      plan_key: 'free',
      effective_plan_key: 'free',
      status: null,
      source: null,
      manage_in_store: null,
      billing_interval: null,
      current_period_end: null,
      trial_ends_at: null,
      cancel_at_period_end: false,
      cancel_at: null,
      has_customer: false,
      can_purchase: true,
      can_cancel: false,
      can_resume: false,
      features,
    });
    // Stripe の行: いまのまま (解約・取り消しのボタン)。features はそのまま返す
    const proFeatures: PlanFeatures = { ai_daily_limit: 30, ai_feature_caps: { menu_generation_ultimate: 2, menu_generation: 10 } };
    expect(summarizeSubscription(row(), true, 'pro', proFeatures)).toMatchObject({
      source: 'stripe',
      manage_in_store: null,
      can_cancel: true,
      can_resume: false,
      features: proFeatures,
    });
    // 手動付与の行: いまのまま (ボタンなし)
    expect(summarizeSubscription(row({ stripe_subscription_id: null }), false, 'pro', proFeatures)).toMatchObject({
      source: 'manual',
      manage_in_store: null,
      can_cancel: false,
      can_resume: false,
      features: proFeatures,
    });
    // 何も無いとき用の既定の形
    expect(EMPTY_PLAN_FEATURES).toEqual({ ai_daily_limit: null, ai_feature_caps: {} });
  });

  it('BILLING_ERROR_MESSAGES.EXT_STRIPE_NOT_CONFIGURED stays お支払いを受け付けていません (#1911) and contains none of UNFINISHED_WORDS', () => {
    expect(BILLING_ERROR_MESSAGES.EXT_STRIPE_NOT_CONFIGURED).toBe('お支払いを受け付けていません');
    for (const word of UNFINISHED_WORDS) {
      expect(BILLING_ERROR_MESSAGES.EXT_STRIPE_NOT_CONFIGURED, word).not.toContain(word);
    }
  });
});

describe('billing core: 状態の表示文 (§10.3 の表)', () => {
  type Lines = Pick<BillingSummary, 'status' | 'trial_ends_at' | 'current_period_end' | 'cancel_at_period_end' | 'cancel_at'>;
  const base: Lines = {
    status: 'active',
    trial_ends_at: '2026-10-20T15:30:00Z',
    current_period_end: '2026-11-20T15:30:00Z',
    cancel_at_period_end: false,
    cancel_at: null,
  };

  it('billingStatusLines gives one status line per live status (trialing 無料期間中（Xまで） / active ご利用中 / past_due お支払いに問題があります。お支払い方法をご確認ください / grace お支払いが確認できないため一部の機能を制限しています / paused 一時停止中), adds Yに解約されます as a second line when cancel_at_period_end (Y = cancel_at, else current_period_end, else 期間の終わりに解約されます), returns [] for a null or non-live status, and formatBillingDate cuts the date in Asia/Tokyo', () => {
    const first: Array<[Lines['status'], string]> = [
      ['trialing', '無料期間中（2026年10月21日まで）'],
      ['active', 'ご利用中'],
      ['past_due', 'お支払いに問題があります。お支払い方法をご確認ください'],
      ['grace', 'お支払いが確認できないため一部の機能を制限しています'],
      ['paused', '一時停止中'],
    ];
    for (const [status, line] of first) {
      // 予約なし
      expect(billingStatusLines({ ...base, status }), String(status)).toEqual([line]);
      // 予約あり (日付 = cancel_at)
      expect(billingStatusLines({ ...base, status, cancel_at_period_end: true, cancel_at: '2026-12-01T00:00:00Z' }), String(status)).toEqual([
        line,
        '2026年12月1日に解約されます',
      ]);
    }
    // active は「お支払いに問題があります」を出さない
    expect(billingStatusLines({ ...base, status: 'active' }).join('')).not.toContain('お支払いに問題があります');
    // cancel_at が無ければ current_period_end、どちらも無ければ固定の文
    expect(billingStatusLines({ ...base, cancel_at_period_end: true, cancel_at: null })).toEqual(['ご利用中', '2026年11月21日に解約されます']);
    expect(billingStatusLines({ ...base, cancel_at_period_end: true, cancel_at: null, current_period_end: null })).toEqual([
      'ご利用中',
      '期間の終わりに解約されます',
    ]);
    expect(BILLING_CANCEL_SCHEDULED_WITHOUT_DATE_TEXT).toBe('期間の終わりに解約されます');
    // trialing で trial_ends_at が無ければ「無料期間中」だけ
    expect(billingStatusLines({ ...base, status: 'trialing', trial_ends_at: null })).toEqual(['無料期間中']);
    // null・live でない status は空
    expect(billingStatusLines({ ...base, status: null })).toEqual([]);
    expect(billingStatusLines({ ...base, status: 'cancelled', cancel_at_period_end: true })).toEqual([]);
    expect(billingStatusLines({ ...base, status: 'expired' })).toEqual([]);
    expect(billingStatusLines({ ...base, status: 'incomplete' })).toEqual([]);
    // 日本時間で切る (UTC 15:30 は日本時間で翌日)
    expect(formatBillingDate('2026-10-20T15:30:00Z')).toBe('2026年10月21日');
    expect(formatBillingDate('2026-10-20T14:59:59Z')).toBe('2026年10月20日');
    expect(formatBillingDate('not-a-date')).toBeNull();
    expect(formatBillingDate(null)).toBeNull();
  });
});

describe('billing core: Webhook の外形と記録', () => {
  it('StripeEventEnvelopeSchema rejects ids that do not start with evt_', () => {
    const valid = { id: 'evt_1', object: 'event', type: 'invoice.paid', created: 1, livemode: true, data: { object: { id: 'in_1' } } };
    expect(StripeEventEnvelopeSchema.safeParse(valid).success).toBe(true);
    expect(StripeEventEnvelopeSchema.safeParse({ ...valid, id: 'ev_1' }).success).toBe(false);
    expect(StripeEventEnvelopeSchema.safeParse({ ...valid, id: 'sub_1' }).success).toBe(false);
    expect(StripeEventEnvelopeSchema.safeParse({ ...valid, object: 'subscription' }).success).toBe(false);
    expect(StripeEventEnvelopeSchema.safeParse({ ...valid, created: 1.5 }).success).toBe(false);
    const { livemode: _livemode, ...withoutLivemode } = valid;
    expect(StripeEventEnvelopeSchema.safeParse(withoutLivemode).success).toBe(false);
  });

  it('isTerminalStripeStatus is true only for canceled and incomplete_expired; isStripeEventClaim accepts only claimed / completed / in_progress', () => {
    const terminal = ['canceled', 'incomplete_expired'];
    for (const status of ['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'] as const) {
      expect(isTerminalStripeStatus(status), status).toBe(terminal.includes(status));
    }
    for (const value of ['claimed', 'completed', 'in_progress']) expect(isStripeEventClaim(value), value).toBe(true);
    for (const value of ['failed', 'processing', 'pending', '', null, undefined, 1, { claim: 'claimed' }]) {
      expect(isStripeEventClaim(value), String(value)).toBe(false);
    }
  });

  it('minimizeStripeEventPayload keeps only the allowlisted scalar fields, normalizes customer and subscription refs (acacia, basil, expanded) to string ids, and drops customer_email / customer_name / customer_details / customer_address / invoice_pdf / hosted_invoice_url / lines / metadata', () => {
    const personal = {
      customer_email: 'person@example.com',
      customer_name: '山田 太郎',
      customer_details: { email: 'person@example.com', name: '山田 太郎', address: { line1: '東京都' } },
      customer_address: { line1: '東京都' },
      customer_phone: '090-0000-0000',
      customer_shipping: { name: '山田 太郎' },
      invoice_pdf: 'https://pay.stripe.com/invoice/pdf',
      hosted_invoice_url: 'https://invoice.stripe.com/i/x',
      lines: { data: [{ description: '山田 太郎 様' }] },
      metadata: { user_id: USER },
    };
    // acacia: subscription が最上位
    const acacia = minimizeStripeEventPayload(
      event('invoice.paid', {
        id: 'in_1',
        object: 'invoice',
        customer: 'cus_1',
        subscription: 'sub_1',
        status: 'paid',
        created: 1_760_000_000,
        currency: 'jpy',
        amount_due: 980,
        amount_paid: 980,
        attempt_count: 1,
        number: 'ABC-0001',
        period_start: 1_760_000_000,
        period_end: 1_762_600_000,
        ...personal,
      }),
    );
    expect(acacia).toEqual({
      id: 'evt_1',
      object: 'event',
      type: 'invoice.paid',
      created: 1_760_000_000,
      livemode: false,
      data: {
        object: {
          id: 'in_1',
          object: 'invoice',
          status: 'paid',
          created: 1_760_000_000,
          currency: 'jpy',
          amount_due: 980,
          amount_paid: 980,
          attempt_count: 1,
          number: 'ABC-0001',
          period_start: 1_760_000_000,
          period_end: 1_762_600_000,
          customer: 'cus_1',
          subscription: 'sub_1',
        },
      },
    });
    const serialized = JSON.stringify(acacia);
    for (const word of ['person@example.com', '山田', '東京都', '090-0000', 'pay.stripe.com', 'invoice.stripe.com', 'customer_email', 'lines', 'metadata']) {
      expect(serialized, word).not.toContain(word);
    }
    // basil: parent.subscription_details.subscription。customer は展開済みの { id }
    const basil = minimizeStripeEventPayload(
      event('invoice.payment_failed', {
        id: 'in_2',
        object: 'invoice',
        customer: { id: 'cus_2', email: 'person@example.com' },
        parent: { subscription_details: { subscription: { id: 'sub_2' } } },
        ...personal,
      }),
    );
    expect(basil.data.object).toEqual({ id: 'in_2', object: 'invoice', customer: 'cus_2', subscription: 'sub_2' });
    // Checkout Session: subscription は data.object.subscription から。mode・status・Portal の予約の記録 (cancel_at_period_end / cancel_at) は残す
    const session = minimizeStripeEventPayload(
      event('checkout.session.completed', { id: 'cs_1', object: 'checkout.session', mode: 'subscription', status: 'complete', customer: 'cus_3', subscription: { id: 'sub_3' }, ...personal }),
    );
    expect(session.data.object).toEqual({ id: 'cs_1', object: 'checkout.session', mode: 'subscription', status: 'complete', customer: 'cus_3', subscription: 'sub_3' });
    const updated = minimizeStripeEventPayload(
      event('customer.subscription.updated', { id: 'sub_4', object: 'subscription', status: 'active', cancel_at_period_end: true, cancel_at: 1_762_600_000, customer: 'cus_4', items: { data: [] }, ...personal }),
    );
    expect(updated.data.object).toEqual({ id: 'sub_4', object: 'subscription', status: 'active', cancel_at_period_end: true, cancel_at: 1_762_600_000, customer: 'cus_4' });
    // 入れ子のオブジェクトの値は許可リストの項目でも残さない
    const nested = minimizeStripeEventPayload(event('customer.subscription.updated', { id: 'sub_5', status: { value: 'x' }, number: ['a'] }));
    expect(nested.data.object).toEqual({ id: 'sub_5' });
  });
});

describe('billing core: I/O を持たない', () => {
  it('core.ts imports nothing but zod', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/billing/core.ts'), 'utf8');
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    expect(specifiers).toEqual(['zod']);
    // 動的な import・require・fetch・process.env も無い
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/process\.env/);
  });
});

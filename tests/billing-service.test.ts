// @vitest-environment node
/**
 * 課金のユースケース (src/lib/billing/service.ts) の単体テスト (billing/01 §14.1 のテスト 26〜33・90・100・109・110)。
 * StripeGateway と BillingRepository は偽物 (§8.1 のポート) を渡す。DB も Stripe も使わない。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLoggerError, mockGetEffectivePlan } = vi.hoisted(() => ({
  mockLoggerError: vi.fn(),
  mockGetEffectivePlan: vi.fn(async (_userId: string) => 'free'),
}));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mockLoggerError }),
  generateRequestId: () => 'req-test',
}));
vi.mock('@/lib/site-config', () => ({ getSiteUrl: () => 'https://example.test' }));
vi.mock('@/lib/plan/entitlements', () => ({ getEffectivePlan: (userId: string) => mockGetEffectivePlan(userId) }));

import {
  createPortalSession,
  getBillingSummary,
  handleStripeEvent,
  previewCheckout,
  recordStripeEventFailure,
  revokeCancellation,
  scheduleCancellation,
  startCheckout,
  syncCheckoutSession,
  syncSubscription,
  type BillingDeps,
} from '@/lib/billing/service';
import {
  BillingError,
  StripeEventEnvelopeSchema,
  StripeSubscriptionSchema,
  type ApplySubscriptionResult,
  type BillingAuditEntry,
  type BillingCustomerRow,
  type BillingRepository,
  type PlanFeatures,
  type PurchasablePlan,
  type StripeCheckoutSession,
  type StripeEventEnvelope,
  type StripeFormParams,
  type StripeGateway,
  type StripeSubscription,
  type SubscriptionRowView,
  type SubscriptionSnapshot,
} from '@/lib/billing/core';

const USER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-16T00:00:00.000Z');

function stripeSubscription(overrides: Record<string, unknown> = {}): StripeSubscription {
  return StripeSubscriptionSchema.parse({
    id: 'sub_1',
    object: 'subscription',
    customer: 'cus_1',
    status: 'active',
    metadata: { user_id: USER, plan_key: 'pro', interval: 'month' },
    items: { data: [{ id: 'si_1', price: { id: 'price_month', recurring: { interval: 'month' } } }] },
    start_date: 1_760_000_000,
    current_period_start: 1_760_000_000,
    current_period_end: 1_762_600_000,
    cancel_at_period_end: false,
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

function liveRow(overrides: Partial<SubscriptionRowView> = {}): SubscriptionRowView {
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

/** いま効いているプランの AI の上限 (billing/03 §8.6。findPlanFeatures の偽物の既定) */
const PRO_FEATURES: PlanFeatures = { ai_daily_limit: 30, ai_feature_caps: { menu_generation_ultimate: 2, menu_generation: 10 } };

const APPLIED: ApplySubscriptionResult = {
  applied: true,
  subscription_id: 'row-1',
  user_id: USER,
  status_from: 'trialing',
  status_to: 'active',
  plan_key: 'pro',
};

function makeGateway(overrides: Partial<StripeGateway> = {}) {
  const base = {
    mode: 'test' as const,
    createCustomer: vi.fn(async () => ({ id: 'cus_new', object: 'customer' as const })),
    createCheckoutSession: vi.fn(
      async (_params: StripeFormParams): Promise<StripeCheckoutSession> => ({ id: 'cs_1', object: 'checkout.session', mode: 'subscription', url: 'https://checkout.stripe.test/cs_1' }),
    ),
    retrieveCheckoutSession: vi.fn(
      async (sessionId: string): Promise<StripeCheckoutSession> => ({
        id: sessionId,
        object: 'checkout.session',
        mode: 'subscription',
        status: 'complete',
        client_reference_id: USER,
        subscription: 'sub_1',
      }),
    ),
    retrieveSubscription: vi.fn(async (subscriptionId: string) => stripeSubscription({ id: subscriptionId })),
    listCustomerSubscriptions: vi.fn(async (): Promise<StripeSubscription[]> => []),
    updateCancelAtPeriodEnd: vi.fn(async (subscriptionId: string, cancelAtPeriodEnd: boolean) =>
      stripeSubscription({ id: subscriptionId, cancel_at_period_end: cancelAtPeriodEnd, cancel_at: cancelAtPeriodEnd ? 1_762_600_000 : null }),
    ),
    cancelSubscriptionNow: vi.fn(async (subscriptionId: string) => stripeSubscription({ id: subscriptionId, status: 'canceled' })),
    listOpenCheckoutSessions: vi.fn(async (): Promise<StripeCheckoutSession[]> => []),
    expireCheckoutSession: vi.fn(
      async (sessionId: string): Promise<StripeCheckoutSession> => ({ id: sessionId, object: 'checkout.session', mode: 'subscription', status: 'expired' }),
    ),
    anonymizeCustomer: vi.fn(async () => undefined),
    createBillingPortalSession: vi.fn(async (_input: { customerId: string; returnUrl: string }) => ({ url: 'https://billing.stripe.test/p' })),
  };
  // 型は base の vi.fn のまま (差し替えた関数も .mock を持つ vi.fn を渡す)
  return Object.assign(base, overrides);
}

function makeRepository(overrides: Partial<BillingRepository> = {}) {
  const audits: BillingAuditEntry[] = [];
  const base = {
    findPlan: vi.fn(async (_planKey: string): Promise<PurchasablePlan | null> => plan()),
    findPlanKeyByPriceId: vi.fn(async (_priceId: string): Promise<string | null> => null),
    findLiveSubscription: vi.fn(async (_userId: string): Promise<SubscriptionRowView | null> => null),
    hasUsedTrial: vi.fn(async () => false),
    findPlanFeatures: vi.fn(async (_planKey: string): Promise<PlanFeatures> => PRO_FEATURES),
    findCustomer: vi.fn(async (_userId: string): Promise<BillingCustomerRow | null> => null),
    saveCustomer: vi.fn(async (userId: string, stripeCustomerId: string): Promise<BillingCustomerRow> => ({
      stripe_customer_id: stripeCustomerId,
      user_id: userId,
      anonymized_at: null,
    })),
    markCustomerAnonymized: vi.fn(async () => undefined),
    listStripeBackedSubscriptions: vi.fn(async () => []),
    applyStripeSubscription: vi.fn(
      async (_input: { snapshot: SubscriptionSnapshot; fetchedAt: Date; source: string }): Promise<ApplySubscriptionResult> => APPLIED,
    ),
    claimStripeEvent: vi.fn(async () => 'claimed' as const),
    finishStripeEvent: vi.fn(async (_eventId: string, _outcome: { ok: true } | { ok: false; errorCode: string }) => undefined),
    recordAudit: vi.fn(async (entry: BillingAuditEntry) => {
      audits.push(entry);
    }),
  };
  // 監査の差し替え (失敗させる) のときも audits の配列は返す (空のまま)
  return { repository: Object.assign(base, overrides), audits };
}

function deps(gateway: ReturnType<typeof makeGateway>, repository: ReturnType<typeof makeRepository>['repository']): BillingDeps {
  return { gateway, repository, now: () => NOW };
}

function event(type: string, object: Record<string, unknown>, id = 'evt_1'): StripeEventEnvelope {
  return StripeEventEnvelopeSchema.parse({ id, object: 'event', type, created: 1_760_000_000, livemode: false, data: { object } });
}

beforeEach(() => {
  mockLoggerError.mockClear();
  mockGetEffectivePlan.mockClear();
  mockGetEffectivePlan.mockResolvedValue('free');
});

describe('startCheckout / previewCheckout', () => {
  it('startCheckout: 409 when a live row exists (stripe-backed or manual)', async () => {
    for (const row of [liveRow(), liveRow({ stripe_subscription_id: null })]) {
      const gateway = makeGateway();
      const { repository, audits } = makeRepository({ findLiveSubscription: vi.fn(async () => row) });
      const error = await startCheckout(deps(gateway, repository), { id: USER, email: null }, 'pro', 'month').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BillingError);
      expect((error as BillingError).code).toBe('OP_SUBSCRIPTION_ALREADY_ACTIVE');
      // 顧客も Checkout Session も作らない・監査も書かない
      expect(gateway.createCustomer).not.toHaveBeenCalled();
      expect(gateway.createCheckoutSession).not.toHaveBeenCalled();
      expect(repository.saveCustomer).not.toHaveBeenCalled();
      expect(audits).toEqual([]);
    }
  });

  it('startCheckout: 422 when plan is not purchasable for the interval', async () => {
    const cases: Array<PurchasablePlan | null> = [
      null,
      plan({ status: 'draft' }),
      plan({ plan_key: 'free' }),
      plan({ plan_type: 'organization' }),
      plan({ stripe_yearly_price_id: null }),
      plan({ yearly_price_jpy: 0 }),
    ];
    for (const found of cases) {
      const gateway = makeGateway();
      const { repository } = makeRepository({ findPlan: vi.fn(async () => found) });
      const error = await startCheckout(deps(gateway, repository), { id: USER, email: null }, 'pro', 'year').catch((caught: unknown) => caught);
      expect((error as BillingError).code, JSON.stringify(found)).toBe('BILL_PLAN_NOT_PURCHASABLE');
      // プランの検査は live の行の検査より先 (§7.3)
      expect(repository.findLiveSubscription).not.toHaveBeenCalled();
      expect(gateway.createCheckoutSession).not.toHaveBeenCalled();
    }
    // 確認画面の内容も同じ 422
    const { repository } = makeRepository({ findPlan: vi.fn(async () => plan({ status: 'draft' })) });
    const previewError = await previewCheckout({ repository }, USER, 'pro', 'month').catch((caught: unknown) => caught);
    expect((previewError as BillingError).code).toBe('BILL_PLAN_NOT_PURCHASABLE');
  });

  it('startCheckout: creates the customer once and reuses it; trial 0 when already used', async () => {
    // 1 回目: 顧客が無いので作って保存する。試用 7 日
    const gateway = makeGateway();
    const { repository, audits } = makeRepository();
    const result = await startCheckout(deps(gateway, repository), { id: USER, email: 'person@example.com' }, 'pro', 'month');

    expect(result).toEqual({ url: 'https://checkout.stripe.test/cs_1', session_id: 'cs_1' });
    expect(gateway.createCustomer).toHaveBeenCalledTimes(1);
    expect(gateway.createCustomer).toHaveBeenCalledWith({ userId: USER, email: 'person@example.com' });
    expect(repository.saveCustomer).toHaveBeenCalledWith(USER, 'cus_new');
    const params = gateway.createCheckoutSession.mock.calls[0][0];
    expect(params).toMatchObject({
      customer: 'cus_new',
      client_reference_id: USER,
      line_items: [{ price: 'price_month', quantity: 1 }],
      subscription_data: { trial_period_days: 7 },
      success_url: 'https://example.test/account/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}',
    });
    expect(audits).toEqual([
      {
        actor_id: USER,
        action_type: 'user.billing.checkout_started',
        target_type: 'user',
        target_id: USER,
        severity: 'info',
        details: { plan_key: 'pro', interval: 'month', trial_days: 7, checkout_session_id: 'cs_1' },
      },
    ]);

    // 2 回目: 顧客があるので作らない。同じプランの試用は済み → 0 日 (trial_period_days を送らない)
    const gateway2 = makeGateway();
    const { repository: repository2, audits: audits2 } = makeRepository({
      findCustomer: vi.fn(async () => ({ stripe_customer_id: 'cus_existing', user_id: USER, anonymized_at: null })),
      hasUsedTrial: vi.fn(async () => true),
    });
    await startCheckout(deps(gateway2, repository2), { id: USER, email: null }, 'pro', 'year');
    expect(gateway2.createCustomer).not.toHaveBeenCalled();
    expect(repository2.saveCustomer).not.toHaveBeenCalled();
    const params2 = gateway2.createCheckoutSession.mock.calls[0][0];
    expect(params2).toMatchObject({ customer: 'cus_existing', line_items: [{ price: 'price_year', quantity: 1 }] });
    expect(params2.subscription_data).toEqual({ metadata: { user_id: USER, plan_key: 'pro', interval: 'year' } });
    expect(audits2[0].details).toMatchObject({ trial_days: 0, interval: 'year' });
    expect(repository2.hasUsedTrial).toHaveBeenCalledWith(USER, 'pro');

    // Session に url が無ければ 502 (EXT_STRIPE_API_FAILED)。監査は書かない
    const gateway3 = makeGateway({
      createCheckoutSession: vi.fn(async (): Promise<StripeCheckoutSession> => ({ id: 'cs_x', object: 'checkout.session', mode: 'subscription', url: null })),
    });
    const { repository: repository3, audits: audits3 } = makeRepository();
    const error = await startCheckout(deps(gateway3, repository3), { id: USER, email: null }, 'pro', 'month').catch((caught: unknown) => caught);
    expect((error as BillingError).code).toBe('EXT_STRIPE_API_FAILED');
    expect(audits3).toEqual([]);
  });

  it('previewCheckout は Stripe を呼ばずに、金額・試用・購入できるかを返す', async () => {
    const { repository } = makeRepository({ hasUsedTrial: vi.fn(async () => true) });
    expect(await previewCheckout({ repository }, USER, 'pro', 'year')).toEqual({
      plan_key: 'pro',
      display_name: 'Pro',
      interval: 'year',
      amount_jpy: 9800,
      trial_days: 0,
      can_purchase: true,
    });
    const { repository: withLive } = makeRepository({ findLiveSubscription: vi.fn(async () => liveRow()) });
    expect(await previewCheckout({ repository: withLive }, USER, 'pro', 'month')).toMatchObject({ amount_jpy: 980, trial_days: 7, can_purchase: false });
  });
});

describe('syncSubscription / syncCheckoutSession', () => {
  it('syncSubscription: retrieves from Stripe, resolves plan via metadata then price, applies with fetchedAt', async () => {
    // metadata.plan_key があれば Price から引かない
    const gateway = makeGateway();
    const { repository } = makeRepository();
    const result = await syncSubscription(deps(gateway, repository), 'sub_1', 'webhook:evt_1');
    expect(result).toEqual(APPLIED);
    expect(gateway.retrieveSubscription).toHaveBeenCalledWith('sub_1');
    expect(repository.findPlanKeyByPriceId).not.toHaveBeenCalled();
    expect(repository.applyStripeSubscription).toHaveBeenCalledTimes(1);
    const applyInput = repository.applyStripeSubscription.mock.calls[0][0];
    expect(applyInput.fetchedAt).toBe(NOW);
    expect(applyInput.source).toBe('webhook:evt_1');
    expect(applyInput.snapshot).toMatchObject({ stripe_subscription_id: 'sub_1', stripe_customer_id: 'cus_1', user_id: USER, plan_key: 'pro', stripe_status: 'active' });

    // metadata が無い (Dashboard で作った契約) なら Price から引く
    const gateway2 = makeGateway({ retrieveSubscription: vi.fn(async () => stripeSubscription({ metadata: {} })) });
    const { repository: repository2 } = makeRepository({ findPlanKeyByPriceId: vi.fn(async () => 'family_basic') });
    await syncSubscription(deps(gateway2, repository2), 'sub_1', 'checkout_sync');
    expect(repository2.findPlanKeyByPriceId).toHaveBeenCalledWith('price_month');
    expect(repository2.applyStripeSubscription.mock.calls[0][0].snapshot).toMatchObject({ user_id: null, plan_key: 'family_basic' });

    // どちらも無ければ plan_key は null のまま写像へ (SQL が既存の行か BILL_UNKNOWN_PLAN で決める)
    const gateway3 = makeGateway({ retrieveSubscription: vi.fn(async () => stripeSubscription({ metadata: null })) });
    const { repository: repository3 } = makeRepository();
    await syncSubscription(deps(gateway3, repository3), 'sub_1', 'checkout_sync');
    expect(repository3.applyStripeSubscription.mock.calls[0][0].snapshot.plan_key).toBeNull();

    // fetchedAt は取り直しより前の時刻 (now を取り直しの前に読む)
    const order: string[] = [];
    const gateway4 = makeGateway({
      retrieveSubscription: vi.fn(async () => {
        order.push('retrieve');
        return stripeSubscription();
      }),
    });
    const { repository: repository4 } = makeRepository();
    await syncSubscription(
      {
        gateway: gateway4,
        repository: repository4,
        now: () => {
          order.push('now');
          return NOW;
        },
      },
      'sub_1',
      'checkout_sync',
    );
    expect(order).toEqual(['now', 'retrieve']);
  });

  it('syncCheckoutSession: 403 when client_reference_id is not the user; no apply when session is not complete', async () => {
    const other = makeGateway({
      retrieveCheckoutSession: vi.fn(
        async (): Promise<StripeCheckoutSession> => ({
          id: 'cs_1',
          object: 'checkout.session',
          mode: 'subscription',
          status: 'complete',
          client_reference_id: '22222222-2222-4222-8222-222222222222',
          subscription: 'sub_1',
        }),
      ),
    });
    const { repository } = makeRepository();
    const error = await syncCheckoutSession(deps(other, repository), USER, 'cs_1').catch((caught: unknown) => caught);
    expect((error as BillingError).code).toBe('BILL_CHECKOUT_SESSION_MISMATCH');
    expect(other.retrieveSubscription).not.toHaveBeenCalled();
    expect(repository.applyStripeSubscription).not.toHaveBeenCalled();

    for (const session of [
      { status: 'open' as const, subscription: null },
      { status: 'expired' as const, subscription: null },
      { status: 'complete' as const, subscription: null },
    ]) {
      const gateway = makeGateway({
        retrieveCheckoutSession: vi.fn(
          async (): Promise<StripeCheckoutSession> => ({ id: 'cs_1', object: 'checkout.session', mode: 'subscription', client_reference_id: USER, ...session }),
        ),
      });
      const { repository: repo } = makeRepository();
      const summary = await syncCheckoutSession(deps(gateway, repo), USER, 'cs_1');
      expect(repo.applyStripeSubscription).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ status: null, can_purchase: true });
    }

    // complete で契約があれば取り直して写し (source = checkout_sync)、要約を返す
    const gateway = makeGateway();
    const { repository: repo } = makeRepository({ findLiveSubscription: vi.fn(async () => liveRow({ status: 'trialing' })) });
    mockGetEffectivePlan.mockResolvedValue('pro');
    const summary = await syncCheckoutSession(deps(gateway, repo), USER, 'cs_1');
    expect(gateway.retrieveSubscription).toHaveBeenCalledWith('sub_1');
    expect(repo.applyStripeSubscription.mock.calls[0][0].source).toBe('checkout_sync');
    expect(summary).toMatchObject({ plan_key: 'pro', effective_plan_key: 'pro', status: 'trialing', can_cancel: true });
  });

  it('syncSubscription cancels the Stripe subscription immediately and audits system.billing.orphan_subscription_cancelled (target_type stripe_subscription, target_id null, warn) when the apply returns user_deleted with customer_closed and the Stripe status is not terminal; it does not cancel when the status is canceled / incomplete_expired or customer_closed is false; a failed cancel throws', async () => {
    const closed: ApplySubscriptionResult = { applied: false, skipped: 'user_deleted', customer_closed: true };
    for (const status of ['trialing', 'active', 'past_due', 'incomplete', 'unpaid', 'paused']) {
      const gateway = makeGateway({ retrieveSubscription: vi.fn(async () => stripeSubscription({ status })) });
      const { repository, audits } = makeRepository({ applyStripeSubscription: vi.fn(async () => closed) });
      expect(await syncSubscription(deps(gateway, repository), 'sub_1', 'webhook:evt_9')).toEqual(closed);
      expect(gateway.cancelSubscriptionNow, status).toHaveBeenCalledWith('sub_1');
      expect(audits, status).toEqual([
        {
          actor_id: null,
          action_type: 'system.billing.orphan_subscription_cancelled',
          target_type: 'stripe_subscription',
          target_id: null,
          severity: 'warn',
          details: { stripe_subscription_id: 'sub_1', stripe_status: status, source: 'webhook:evt_9' },
        },
      ]);
    }
    // 終端なら解約しない
    for (const status of ['canceled', 'incomplete_expired']) {
      const gateway = makeGateway({ retrieveSubscription: vi.fn(async () => stripeSubscription({ status })) });
      const { repository, audits } = makeRepository({ applyStripeSubscription: vi.fn(async () => closed) });
      await syncSubscription(deps(gateway, repository), 'sub_1', 'webhook:evt_9');
      expect(gateway.cancelSubscriptionNow, status).not.toHaveBeenCalled();
      expect(audits).toEqual([]);
    }
    // 対応表に無い顧客 (customer_closed = false) なら解約しない
    const gateway = makeGateway();
    const { repository, audits } = makeRepository({
      applyStripeSubscription: vi.fn(async (): Promise<ApplySubscriptionResult> => ({ applied: false, skipped: 'user_deleted', customer_closed: false })),
    });
    await syncSubscription(deps(gateway, repository), 'sub_1', 'webhook:evt_9');
    expect(gateway.cancelSubscriptionNow).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
    // 解約の失敗は投げる (Webhook は failed・500 で Stripe が再送する)。監査は書かない
    const failing = makeGateway({ cancelSubscriptionNow: vi.fn(async () => Promise.reject(new Error('stripe down'))) });
    const { repository: failingRepo, audits: failingAudits } = makeRepository({ applyStripeSubscription: vi.fn(async () => closed) });
    await expect(syncSubscription(deps(failing, failingRepo), 'sub_1', 'webhook:evt_9')).rejects.toThrow('stripe down');
    expect(failingAudits).toEqual([]);
  });
});

describe('getBillingSummary / createPortalSession', () => {
  it('getBillingSummary は Stripe を呼ばず、live な行・顧客・get_effective_plan から要約を作る', async () => {
    const { repository } = makeRepository({
      findLiveSubscription: vi.fn(async () => liveRow({ cancel_at_period_end: true, cancel_at: '2026-11-20T15:00:00.000Z' })),
      findCustomer: vi.fn(async () => ({ stripe_customer_id: 'cus_1', user_id: USER, anonymized_at: null })),
    });
    mockGetEffectivePlan.mockResolvedValue('pro');
    expect(await getBillingSummary({ repository }, USER)).toMatchObject({
      plan_key: 'pro',
      effective_plan_key: 'pro',
      status: 'active',
      has_customer: true,
      can_resume: true,
      can_cancel: false,
      manage_in_store: null,
      features: PRO_FEATURES,
    });
    expect(mockGetEffectivePlan).toHaveBeenCalledWith(USER);
    // features は効いているプラン (get_effective_plan) で読む (billing/03 §8.6)
    expect(repository.findPlanFeatures).toHaveBeenCalledWith('pro');
  });

  it('createPortalSession は顧客が無ければ 404、あれば戻り先 /account/billing で Portal を作る', async () => {
    const gateway = makeGateway();
    const { repository } = makeRepository();
    const error = await createPortalSession(deps(gateway, repository), USER).catch((caught: unknown) => caught);
    expect((error as BillingError).code).toBe('BILL_CUSTOMER_NOT_FOUND');
    expect(gateway.createBillingPortalSession).not.toHaveBeenCalled();

    const { repository: withCustomer } = makeRepository({
      findCustomer: vi.fn(async () => ({ stripe_customer_id: 'cus_1', user_id: USER, anonymized_at: null })),
    });
    expect(await createPortalSession(deps(gateway, withCustomer), USER)).toEqual({ url: 'https://billing.stripe.test/p' });
    expect(gateway.createBillingPortalSession).toHaveBeenCalledWith({ customerId: 'cus_1', returnUrl: 'https://example.test/account/billing' });
  });
});

describe('scheduleCancellation / revokeCancellation', () => {
  it('scheduleCancellation is idempotent and audits once (a Stripe-backed paused row can be scheduled too); revokeCancellation 409 when not scheduled; both throw BILL_NO_LIVE_SUBSCRIPTION without calling Stripe when there is no live row or the live row is manual (stripe_subscription_id null)', async () => {
    // 予約: Stripe を呼び、写像 (api:cancel)・監査 1 行
    for (const status of ['active', 'paused']) {
      const gateway = makeGateway();
      const { repository, audits } = makeRepository({ findLiveSubscription: vi.fn(async () => liveRow({ status })) });
      await scheduleCancellation(deps(gateway, repository), USER);
      expect(gateway.updateCancelAtPeriodEnd, status).toHaveBeenCalledWith('sub_1', true);
      const applyInput = repository.applyStripeSubscription.mock.calls[0][0];
      expect(applyInput).toMatchObject({ fetchedAt: NOW, source: 'api:cancel' });
      expect(applyInput.snapshot).toMatchObject({ plan_key: 'pro', cancel_at_period_end: true, stripe_subscription_id: 'sub_1' });
      expect(audits).toEqual([
        {
          actor_id: USER,
          action_type: 'user.billing.cancel_scheduled',
          target_type: 'user',
          target_id: USER,
          severity: 'info',
          details: { stripe_subscription_id: 'sub_1', plan_key: 'pro' },
        },
      ]);
    }

    // 予約済みの 2 回目: 何もしない (Stripe も写像も監査も無し)。要約を返す
    const gateway = makeGateway();
    const { repository, audits } = makeRepository({
      findLiveSubscription: vi.fn(async () => liveRow({ cancel_at_period_end: true, cancel_at: '2026-11-20T15:00:00.000Z' })),
    });
    const summary = await scheduleCancellation(deps(gateway, repository), USER);
    expect(gateway.updateCancelAtPeriodEnd).not.toHaveBeenCalled();
    expect(repository.applyStripeSubscription).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
    expect(summary).toMatchObject({ can_resume: true, cancel_at_period_end: true });

    // 取り消し: 予約が無ければ 409 BILL_CANCEL_NOT_SCHEDULED (Stripe を呼ばない)
    const notScheduled = makeGateway();
    const { repository: notScheduledRepo, audits: notScheduledAudits } = makeRepository({ findLiveSubscription: vi.fn(async () => liveRow()) });
    const notScheduledError = await revokeCancellation(deps(notScheduled, notScheduledRepo), USER).catch((caught: unknown) => caught);
    expect((notScheduledError as BillingError).code).toBe('BILL_CANCEL_NOT_SCHEDULED');
    expect(notScheduled.updateCancelAtPeriodEnd).not.toHaveBeenCalled();
    expect(notScheduledAudits).toEqual([]);

    // 取り消し: 予約中なら Stripe を呼び、写像 (api:resume)・監査
    const scheduled = makeGateway();
    const { repository: scheduledRepo, audits: scheduledAudits } = makeRepository({
      findLiveSubscription: vi.fn(async () => liveRow({ cancel_at_period_end: true })),
    });
    await revokeCancellation(deps(scheduled, scheduledRepo), USER);
    expect(scheduled.updateCancelAtPeriodEnd).toHaveBeenCalledWith('sub_1', false);
    expect(scheduledRepo.applyStripeSubscription.mock.calls[0][0]).toMatchObject({ source: 'api:resume', fetchedAt: NOW });
    expect(scheduledAudits.map((entry) => entry.action_type)).toEqual(['user.billing.cancel_revoked']);

    // live な行が無い・手動付与の行: どちらも BILL_NO_LIVE_SUBSCRIPTION (Stripe を呼ばない)
    for (const row of [null, liveRow({ stripe_subscription_id: null }), liveRow({ stripe_subscription_id: null, cancel_at_period_end: true })]) {
      for (const run of [scheduleCancellation, revokeCancellation]) {
        const noLive = makeGateway();
        const { repository: noLiveRepo, audits: noLiveAudits } = makeRepository({ findLiveSubscription: vi.fn(async () => row) });
        const error = await run(deps(noLive, noLiveRepo), USER).catch((caught: unknown) => caught);
        expect((error as BillingError).code, `${run.name} ${JSON.stringify(row)}`).toBe('BILL_NO_LIVE_SUBSCRIPTION');
        expect(noLive.updateCancelAtPeriodEnd).not.toHaveBeenCalled();
        expect(noLiveRepo.applyStripeSubscription).not.toHaveBeenCalled();
        expect(noLiveAudits).toEqual([]);
      }
    }

    // 監査の失敗は本体を止めない (fail-open)。失敗はログに残す
    const auditFails = makeGateway();
    const { repository: auditFailsRepo } = makeRepository({
      findLiveSubscription: vi.fn(async () => liveRow()),
      recordAudit: vi.fn(async () => Promise.reject(new Error('audit insert failed'))),
    });
    await expect(scheduleCancellation(deps(auditFails, auditFailsRepo), USER)).resolves.toMatchObject({ status: 'active' });
    expect(mockLoggerError).toHaveBeenCalledWith('課金の監査ログの記録に失敗しました', expect.any(Error), { action_type: 'user.billing.cancel_scheduled' });
  });
});

describe('handleStripeEvent', () => {
  it('handleStripeEvent: ignore / sync_subscription / invoice with and without subscription / payment_failed audits', async () => {
    // ignore: Stripe も DB も触らない
    const ignoreGateway = makeGateway();
    const { repository: ignoreRepo } = makeRepository();
    expect(await handleStripeEvent(deps(ignoreGateway, ignoreRepo), event('customer.updated', { id: 'cus_1' }))).toEqual({
      action: 'ignored',
      detail: 'customer.updated',
    });
    expect(ignoreGateway.retrieveSubscription).not.toHaveBeenCalled();
    expect(ignoreRepo.applyStripeSubscription).not.toHaveBeenCalled();

    // sync_subscription: data.object.id で取り直して写す (source = webhook:<event.id>)
    const gateway = makeGateway();
    const { repository } = makeRepository();
    expect(await handleStripeEvent(deps(gateway, repository), event('customer.subscription.updated', { id: 'sub_9', object: 'subscription' }, 'evt_77')))
      .toEqual({ action: 'synced', detail: 'active' });
    expect(gateway.retrieveSubscription).toHaveBeenCalledWith('sub_9');
    expect(repository.applyStripeSubscription.mock.calls[0][0].source).toBe('webhook:evt_77');

    // id の無い data.object は skipped
    const { repository: noIdRepo } = makeRepository();
    expect(await handleStripeEvent(deps(makeGateway(), noIdRepo), event('customer.subscription.updated', { object: 'subscription' }))).toEqual({
      action: 'skipped',
      detail: 'no_object_id',
    });

    // stale・user_deleted は skipped
    const { repository: staleRepo } = makeRepository({
      applyStripeSubscription: vi.fn(async (): Promise<ApplySubscriptionResult> => ({ applied: false, skipped: 'stale', subscription_id: 'row-1', user_id: USER })),
    });
    expect(await handleStripeEvent(deps(makeGateway(), staleRepo), event('customer.subscription.created', { id: 'sub_1' }))).toEqual({
      action: 'skipped',
      detail: 'stale',
    });

    // checkout.session.completed: Session を取り直し、subscription の Session だけ写す
    const checkoutGateway = makeGateway();
    const { repository: checkoutRepo } = makeRepository();
    expect(await handleStripeEvent(deps(checkoutGateway, checkoutRepo), event('checkout.session.completed', { id: 'cs_1', object: 'checkout.session' }))).toEqual({
      action: 'synced',
      detail: 'active',
    });
    expect(checkoutGateway.retrieveCheckoutSession).toHaveBeenCalledWith('cs_1');
    expect(checkoutGateway.retrieveSubscription).toHaveBeenCalledWith('sub_1');
    const paymentGateway = makeGateway({
      retrieveCheckoutSession: vi.fn(async (): Promise<StripeCheckoutSession> => ({ id: 'cs_2', object: 'checkout.session', mode: 'payment', subscription: null })),
    });
    const { repository: paymentRepo } = makeRepository();
    expect(await handleStripeEvent(deps(paymentGateway, paymentRepo), event('checkout.session.completed', { id: 'cs_2' }))).toEqual({
      action: 'skipped',
      detail: 'not_subscription_session',
    });
    expect(paymentRepo.applyStripeSubscription).not.toHaveBeenCalled();

    // invoice.paid: 請求の subscription を取り直す。subscription の無い請求は skipped
    const invoiceGateway = makeGateway();
    const { repository: invoiceRepo, audits: invoiceAudits } = makeRepository();
    expect(await handleStripeEvent(deps(invoiceGateway, invoiceRepo), event('invoice.paid', { id: 'in_1', object: 'invoice', subscription: 'sub_5' })))
      .toEqual({ action: 'synced', detail: 'active' });
    expect(invoiceGateway.retrieveSubscription).toHaveBeenCalledWith('sub_5');
    expect(invoiceAudits).toEqual([]);
    const { repository: noSubRepo } = makeRepository();
    expect(await handleStripeEvent(deps(makeGateway(), noSubRepo), event('invoice.paid', { id: 'in_2', object: 'invoice' }))).toEqual({
      action: 'skipped',
      detail: 'invoice_without_subscription',
    });

    // invoice.payment_failed: 写像のあとに system.payment.failed (warn) を 1 行
    const failedGateway = makeGateway();
    const { repository: failedRepo, audits: failedAudits } = makeRepository();
    await handleStripeEvent(
      deps(failedGateway, failedRepo),
      event('invoice.payment_failed', { id: 'in_3', object: 'invoice', parent: { subscription_details: { subscription: 'sub_6' } }, attempt_count: 2, amount_due: 980 }, 'evt_pf'),
    );
    expect(failedGateway.retrieveSubscription).toHaveBeenCalledWith('sub_6');
    expect(failedAudits).toEqual([
      {
        actor_id: null,
        action_type: 'system.payment.failed',
        target_type: 'user',
        target_id: USER,
        severity: 'warn',
        details: { stripe_subscription_id: 'sub_6', invoice_id: 'in_3', attempt_count: 2, amount_due: 980, event_id: 'evt_pf' },
      },
    ]);
    // subscription の無い支払失敗は監査も書かない
    const { repository: failedNoSubRepo, audits: failedNoSubAudits } = makeRepository();
    expect(await handleStripeEvent(deps(makeGateway(), failedNoSubRepo), event('invoice.payment_failed', { id: 'in_4', object: 'invoice' }))).toEqual({
      action: 'skipped',
      detail: 'invoice_without_subscription',
    });
    expect(failedNoSubAudits).toEqual([]);
  });

  it('handleStripeEvent audits system.payment.failed for invoice.payment_failed when the apply is applied or skipped as stale (target_id = the user_id returned with stale), and does not audit when skipped as user_deleted', async () => {
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const cases: Array<[ApplySubscriptionResult, string | null]> = [
      [APPLIED, USER],
      [{ applied: false, skipped: 'stale', subscription_id: 'row-1', user_id: OTHER }, OTHER],
      [{ applied: false, skipped: 'user_deleted', customer_closed: false }, null],
      [{ applied: false, skipped: 'user_deleted', customer_closed: true }, null],
    ];
    for (const [result, expectedTarget] of cases) {
      const gateway = makeGateway({ retrieveSubscription: vi.fn(async () => stripeSubscription({ status: 'past_due' })) });
      const { repository, audits } = makeRepository({ applyStripeSubscription: vi.fn(async () => result) });
      await handleStripeEvent(deps(gateway, repository), event('invoice.payment_failed', { id: 'in_1', object: 'invoice', subscription: 'sub_1' }));
      const paymentFailed = audits.filter((entry) => entry.action_type === 'system.payment.failed');
      if (expectedTarget === null) {
        expect(paymentFailed, JSON.stringify(result)).toEqual([]);
      } else {
        expect(paymentFailed.map((entry) => entry.target_id), JSON.stringify(result)).toEqual([expectedTarget]);
      }
    }
  });

  it('handleStripeEvent re-fetches and applies the subscription for customer.subscription.trial_will_end / pending_update_applied / pending_update_expired (syncSubscription with the object id) and for the subscription of invoice.payment_action_required (skipped as invoice_without_subscription when the invoice has none), and writes no system.payment.failed audit for any of them', async () => {
    for (const type of ['customer.subscription.trial_will_end', 'customer.subscription.pending_update_applied', 'customer.subscription.pending_update_expired']) {
      const gateway = makeGateway();
      const { repository, audits } = makeRepository();
      expect(await handleStripeEvent(deps(gateway, repository), event(type, { id: 'sub_42', object: 'subscription' })), type).toEqual({
        action: 'synced',
        detail: 'active',
      });
      expect(gateway.retrieveSubscription).toHaveBeenCalledWith('sub_42');
      expect(repository.applyStripeSubscription).toHaveBeenCalledTimes(1);
      expect(audits).toEqual([]);
    }
    const gateway = makeGateway();
    const { repository, audits } = makeRepository();
    expect(
      await handleStripeEvent(deps(gateway, repository), event('invoice.payment_action_required', { id: 'in_1', object: 'invoice', subscription: 'sub_43' })),
    ).toEqual({ action: 'synced', detail: 'active' });
    expect(gateway.retrieveSubscription).toHaveBeenCalledWith('sub_43');
    expect(audits).toEqual([]);
    const { repository: noSub, audits: noSubAudits } = makeRepository();
    expect(await handleStripeEvent(deps(makeGateway(), noSub), event('invoice.payment_action_required', { id: 'in_2', object: 'invoice' }))).toEqual({
      action: 'skipped',
      detail: 'invoice_without_subscription',
    });
    expect(noSub.applyStripeSubscription).not.toHaveBeenCalled();
    expect(noSubAudits).toEqual([]);
  });

  it('handleStripeEvent uses nothing from data.object except id, the invoice subscription ref, and the invoice id / attempt_count / amount_due in the system.payment.failed audit details, and the apply snapshot comes only from the re-fetched subscription', async () => {
    const MARKERS = ['MARK_EMAIL@example.com', 'MARK_NAME', 'MARK_STATUS', 'MARK_META', 'MARK_LINE'];
    const MARK_AMOUNT_PAID = 987_654_321;
    const noise = {
      customer_email: MARKERS[0],
      customer_name: MARKERS[1],
      status: MARKERS[2],
      metadata: { user_id: MARKERS[3], plan_key: MARKERS[3] },
      lines: { data: [{ description: MARKERS[4] }] },
      amount_paid: MARK_AMOUNT_PAID,
      cancel_at_period_end: 'MARK_CANCEL',
      current_period_end: 'MARK_PERIOD',
    };
    const refetched = stripeSubscription({ id: 'sub_r', status: 'past_due' });
    const scenarios: Array<[string, Record<string, unknown>]> = [
      ['customer.subscription.updated', { id: 'sub_r', object: 'subscription', ...noise }],
      ['invoice.paid', { id: 'in_r', object: 'invoice', subscription: 'sub_r', attempt_count: 3, amount_due: 1234, ...noise }],
      ['invoice.payment_failed', { id: 'in_r', object: 'invoice', subscription: 'sub_r', attempt_count: 3, amount_due: 1234, ...noise }],
    ];
    for (const [type, object] of scenarios) {
      const gateway = makeGateway({ retrieveSubscription: vi.fn(async () => refetched) });
      const { repository, audits } = makeRepository();
      await handleStripeEvent(deps(gateway, repository), event(type, object, 'evt_r'));

      const allCalls = JSON.stringify([
        ...Object.values(gateway).filter((value) => typeof value === 'function').map((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls),
        ...Object.values(repository).map((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls),
      ]);
      for (const marker of [...MARKERS, String(MARK_AMOUNT_PAID), 'MARK_CANCEL', 'MARK_PERIOD']) {
        expect(allCalls, `${type}: ${marker}`).not.toContain(marker);
      }
      // 写像の snapshot は取り直した Subscription から作る (請求の attempt_count・amount_due を持たない)
      const snapshot = repository.applyStripeSubscription.mock.calls[0][0].snapshot;
      expect(snapshot).toMatchObject({ stripe_subscription_id: 'sub_r', stripe_status: 'past_due', user_id: USER, plan_key: 'pro', cancel_at_period_end: false });
      expect(JSON.stringify(snapshot)).not.toContain('1234');
      expect(Object.keys(snapshot)).not.toContain('attempt_count');
      expect(Object.keys(snapshot)).not.toContain('amount_due');

      const paymentFailed = audits.filter((entry) => entry.action_type === 'system.payment.failed');
      if (type === 'invoice.payment_failed') {
        expect(paymentFailed).toHaveLength(1);
        expect(Object.keys(paymentFailed[0].details).sort()).toEqual(['amount_due', 'attempt_count', 'event_id', 'invoice_id', 'stripe_subscription_id']);
        expect(paymentFailed[0].details).toEqual({ stripe_subscription_id: 'sub_r', invoice_id: 'in_r', attempt_count: 3, amount_due: 1234, event_id: 'evt_r' });
      } else {
        expect(paymentFailed).toEqual([]);
      }
    }
  });
});

describe('recordStripeEventFailure', () => {
  it('recordStripeEventFailure finishes the event as failed and audits system.stripe.event_failed with target_type stripe_event and target_id null, and still resolves when the audit fails', async () => {
    const gateway = makeGateway();
    const { repository, audits } = makeRepository();
    const failedEvent = event('customer.subscription.updated', { id: 'sub_1' }, 'evt_fail');
    await recordStripeEventFailure(deps(gateway, repository), failedEvent, 'BILL_UNKNOWN_PLAN');

    expect(repository.finishStripeEvent).toHaveBeenCalledWith('evt_fail', { ok: false, errorCode: 'BILL_UNKNOWN_PLAN' });
    expect(audits).toEqual([
      {
        actor_id: null,
        action_type: 'system.stripe.event_failed',
        target_type: 'stripe_event',
        target_id: null,
        severity: 'warn',
        details: { event_id: 'evt_fail', event_type: 'customer.subscription.updated', error_code: 'BILL_UNKNOWN_PLAN' },
      },
    ]);

    // 監査の失敗は飲み込む (finish は済んでいる)
    const { repository: auditFails } = makeRepository({ recordAudit: vi.fn(async () => Promise.reject(new Error('audit down'))) });
    await expect(recordStripeEventFailure(deps(gateway, auditFails), failedEvent, 'SYS_INTERNAL_ERROR')).resolves.toBeUndefined();
    expect(auditFails.finishStripeEvent).toHaveBeenCalledWith('evt_fail', { ok: false, errorCode: 'SYS_INTERNAL_ERROR' });

    // finish の失敗は投げる (route が 500。行は processing のまま)。監査は書かない
    const { repository: finishFails, audits: finishFailsAudits } = makeRepository({
      finishStripeEvent: vi.fn(async () => Promise.reject(new Error('db down'))),
    });
    await expect(recordStripeEventFailure(deps(gateway, finishFails), failedEvent, 'SYS_INTERNAL_ERROR')).rejects.toThrow('db down');
    expect(finishFailsAudits).toEqual([]);
  });
});

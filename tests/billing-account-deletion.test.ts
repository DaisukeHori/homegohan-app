// @vitest-environment node
/**
 * 退会の段階 billing / billing_recheck (src/lib/billing/account-deletion.ts) の単体テスト (billing/01 §14.1 のテスト 82・83・108)。
 * StripeGateway と BillingRepository は偽物。Stripe・DB には触れない。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    gateway: null as unknown,
    repository: null as unknown,
  },
}));
vi.mock('@/lib/billing/stripe-gateway', () => ({ createStripeGateway: () => state.gateway }));
vi.mock('@/lib/billing/repository', () => ({ createBillingRepository: () => state.repository }));

import { collectSubscriptionsToCancel, defaultAccountDeletionBilling, expireOpenCheckoutSessions } from '@/lib/billing/account-deletion';
import {
  StripeApiError,
  StripeSubscriptionSchema,
  type BillingAuditEntry,
  type BillingCustomerRow,
  type StripeCheckoutSession,
  type StripeGateway,
  type StripeSubscription,
} from '@/lib/billing/core';
import type { AccountDeletionBillingLogger } from '@/lib/account-deletion';

const USER = '11111111-1111-4111-8111-111111111111';

function sub(id: string, status: string, customer = 'cus_1'): StripeSubscription {
  return StripeSubscriptionSchema.parse({
    id,
    object: 'subscription',
    customer,
    status,
    metadata: {},
    items: { data: [] },
    start_date: 1_760_000_000,
    cancel_at_period_end: false,
  });
}

function session(id: string, status: 'open' | 'complete' | 'expired'): StripeCheckoutSession {
  return { id, object: 'checkout.session', mode: 'subscription', status };
}

/** Stripe の状態 (顧客の契約・開いた Session) を持つ偽の gateway。呼ばれた順を calls に残す */
function makeStripe(initial: { subscriptions?: StripeSubscription[]; extraById?: StripeSubscription[]; openSessions?: StripeCheckoutSession[] } = {}) {
  const calls: string[] = [];
  const world = {
    subscriptions: [...(initial.subscriptions ?? [])],
    extraById: new Map((initial.extraById ?? []).map((item) => [item.id, item])),
    openSessions: [...(initial.openSessions ?? [])],
    /** expire を呼んだときに、すでに完了・期限切れになっていた Session (Stripe が 4xx) */
    sessionStatusAtExpire: new Map<string, 'complete' | 'expired' | 'open'>(),
  };
  const fail = (): never => {
    throw new Error('not expected');
  };
  const gateway: StripeGateway = {
    mode: 'test',
    createCustomer: fail,
    createCheckoutSession: fail,
    createBillingPortalSession: fail,
    updateCancelAtPeriodEnd: fail,
    listCustomerSubscriptions: vi.fn(async (customerId: string) => {
      calls.push(`listCustomerSubscriptions:${customerId}`);
      return world.subscriptions.filter((item) => item.customer === customerId);
    }),
    retrieveSubscription: vi.fn(async (id: string) => {
      calls.push(`retrieveSubscription:${id}`);
      const found = world.subscriptions.find((item) => item.id === id) ?? world.extraById.get(id);
      if (!found) throw new StripeApiError({ status: 404 });
      return found;
    }),
    cancelSubscriptionNow: vi.fn(async (id: string) => {
      calls.push(`cancelSubscriptionNow:${id}`);
      return sub(id, 'canceled');
    }),
    listOpenCheckoutSessions: vi.fn(async (customerId: string) => {
      calls.push(`listOpenCheckoutSessions:${customerId}`);
      return [...world.openSessions];
    }),
    expireCheckoutSession: vi.fn(async (id: string) => {
      calls.push(`expireCheckoutSession:${id}`);
      const status = world.sessionStatusAtExpire.get(id) ?? 'open';
      if (status !== 'open') throw new StripeApiError({ status: 400, stripeCode: 'checkout_session_not_open' });
      world.openSessions = world.openSessions.filter((item) => item.id !== id);
      return session(id, 'expired');
    }),
    retrieveCheckoutSession: vi.fn(async (id: string) => {
      calls.push(`retrieveCheckoutSession:${id}`);
      return session(id, world.sessionStatusAtExpire.get(id) ?? 'open');
    }),
    anonymizeCustomer: vi.fn(async (customerId: string) => {
      calls.push(`anonymizeCustomer:${customerId}`);
    }),
  };
  return { gateway, calls, world };
}

function makeRepository(initial: { customer?: BillingCustomerRow | null; rows?: Array<{ stripe_subscription_id: string; status: string }> } = {}) {
  const audits: BillingAuditEntry[] = [];
  const db = { customer: initial.customer ?? null, rows: initial.rows ?? [] };
  const repository = {
    findCustomer: vi.fn(async (userId: string) => {
      expect(userId).toBe(USER);
      return db.customer;
    }),
    listStripeBackedSubscriptions: vi.fn(async (userId: string) => {
      expect(userId).toBe(USER);
      return db.rows;
    }),
    markCustomerAnonymized: vi.fn(async (stripeCustomerId: string, anonymizedAtIso: string) => {
      if (db.customer && db.customer.stripe_customer_id === stripeCustomerId) db.customer = { ...db.customer, anonymized_at: anonymizedAtIso };
    }),
    recordAudit: vi.fn(async (entry: BillingAuditEntry) => {
      audits.push(entry);
    }),
  };
  return { repository, audits, db };
}

function makeLog() {
  const info = vi.fn();
  const warn = vi.fn();
  const log: AccountDeletionBillingLogger = { info, warn };
  return { log, info, warn };
}

function use(gateway: StripeGateway, repository: ReturnType<typeof makeRepository>['repository']) {
  state.gateway = gateway;
  state.repository = repository;
}

beforeEach(() => {
  state.gateway = null;
  state.repository = null;
});

describe('collectSubscriptionsToCancel', () => {
  it('collectSubscriptionsToCancel unions the Stripe customer list with DB rows, retrieves DB-only ones, and drops canceled / incomplete_expired', async () => {
    const { gateway, calls } = makeStripe({
      subscriptions: [sub('sub_a', 'active'), sub('sub_b', 'canceled'), sub('sub_c', 'incomplete_expired'), sub('sub_d', 'past_due')],
      extraById: [sub('sub_other', 'trialing', 'cus_other'), sub('sub_other_done', 'canceled', 'cus_other')],
    });

    const result = await collectSubscriptionsToCancel(gateway, 'cus_1', ['sub_a', 'sub_other', 'sub_other_done']);

    expect(result.map((item) => item.id).sort()).toEqual(['sub_a', 'sub_d', 'sub_other']);
    // 顧客の一覧にあった sub_a は取り直さない。DB だけにあったものは取り直す
    expect(calls).toEqual(['listCustomerSubscriptions:cus_1', 'retrieveSubscription:sub_other', 'retrieveSubscription:sub_other_done']);

    // 顧客が無ければ DB の行だけ
    const second = makeStripe({ extraById: [sub('sub_x', 'active')] });
    expect((await collectSubscriptionsToCancel(second.gateway, null, ['sub_x'])).map((item) => item.id)).toEqual(['sub_x']);
    expect(second.calls).toEqual(['retrieveSubscription:sub_x']);
  });
});

describe('expireOpenCheckoutSessions', () => {
  it('開いた Session を全部閉じて数を返す。閉じる前に完了した Session は取り直して飛ばし、open のままなら投げる', async () => {
    const { gateway, world, calls } = makeStripe({ openSessions: [session('cs_1', 'open'), session('cs_2', 'open'), session('cs_3', 'open')] });
    world.sessionStatusAtExpire.set('cs_2', 'complete');
    expect(await expireOpenCheckoutSessions(gateway, 'cus_1')).toBe(2);
    expect(calls).toEqual([
      'listOpenCheckoutSessions:cus_1',
      'expireCheckoutSession:cs_1',
      'expireCheckoutSession:cs_2',
      'retrieveCheckoutSession:cs_2',
      'expireCheckoutSession:cs_3',
    ]);

    // expire が失敗し、取り直しても open のまま → 元の例外を投げる
    const stuck = makeStripe({ openSessions: [session('cs_9', 'open')] });
    const original = new StripeApiError({ status: 500 });
    stuck.gateway.expireCheckoutSession = vi.fn(async () => {
      throw original;
    });
    await expect(expireOpenCheckoutSessions(stuck.gateway, 'cus_1')).rejects.toBe(original);
  });
});

describe('defaultAccountDeletionBilling.cancelForAccountDeletion', () => {
  it('cancelForAccountDeletion cancels a Stripe subscription that has no DB row (webhook not yet arrived / BILL_LIVE_ROW_CONFLICT) and anonymizes the customer', async () => {
    const { gateway, calls } = makeStripe({ subscriptions: [sub('sub_live', 'active'), sub('sub_no_row', 'trialing'), sub('sub_done', 'canceled')] });
    const { repository, audits, db } = makeRepository({
      customer: { stripe_customer_id: 'cus_1', user_id: USER, anonymized_at: null },
      rows: [{ stripe_subscription_id: 'sub_live', status: 'active' }],
    });
    use(gateway, repository);
    const { log, info } = makeLog();

    const report = await defaultAccountDeletionBilling.cancelForAccountDeletion(USER, log, 'billing');

    expect(report).toEqual({ cancelled_subscriptions: 2, expired_checkout_sessions: 0, customer: 'anonymized' });
    expect(calls.filter((call) => call.startsWith('cancelSubscriptionNow')).sort()).toEqual(['cancelSubscriptionNow:sub_live', 'cancelSubscriptionNow:sub_no_row']);
    expect(calls).toContain('anonymizeCustomer:cus_1');
    expect(gateway.anonymizeCustomer).toHaveBeenCalledWith('cus_1', expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    const anonymizedAt = vi.mocked(gateway.anonymizeCustomer).mock.calls[0][1];
    expect(repository.markCustomerAnonymized).toHaveBeenCalledWith('cus_1', anonymizedAt);
    expect(db.customer?.anonymized_at).toBe(anonymizedAt);
    expect(audits).toEqual([
      {
        actor_id: null,
        action_type: 'system.billing.account_deletion_stripe_cancelled',
        target_type: 'user',
        target_id: USER,
        severity: 'info',
        details: { phase: 'billing', cancelled_subscriptions: 2, expired_checkout_sessions: 0, stripe_customer_id: 'cus_1' },
      },
    ]);
    expect(info).toHaveBeenCalledTimes(1);
    // ログにメールアドレス・氏名を渡さない (数と phase だけ)
    expect(info.mock.calls[0][1]).toEqual({ phase: 'billing', cancelled_subscriptions: 2, expired_checkout_sessions: 0 });

    // 顧客の行が無くても、DB の Stripe-backed の行は解約する (顧客は none)
    const noCustomer = makeStripe({ extraById: [sub('sub_orphan', 'active', 'cus_unknown')] });
    const noCustomerRepo = makeRepository({ customer: null, rows: [{ stripe_subscription_id: 'sub_orphan', status: 'active' }] });
    use(noCustomer.gateway, noCustomerRepo.repository);
    expect(await defaultAccountDeletionBilling.cancelForAccountDeletion(USER, makeLog().log, 'billing')).toEqual({
      cancelled_subscriptions: 1,
      expired_checkout_sessions: 0,
      customer: 'none',
    });
    expect(noCustomer.calls).toEqual(['retrieveSubscription:sub_orphan', 'cancelSubscriptionNow:sub_orphan']);
    expect(noCustomerRepo.audits).toEqual([]);

    // 顧客も行も無ければ gateway を作らない (鍵が無くても通る)
    const none = makeRepository({ customer: null, rows: [] });
    use(null as unknown as StripeGateway, none.repository);
    expect(await defaultAccountDeletionBilling.cancelForAccountDeletion(USER, makeLog().log, 'billing')).toEqual({
      cancelled_subscriptions: 0,
      expired_checkout_sessions: 0,
      customer: 'none',
    });

    // 解約の失敗は投げる (その段階で止める)。匿名化に進まない
    const failing = makeStripe({ subscriptions: [sub('sub_live', 'active')] });
    failing.gateway.cancelSubscriptionNow = vi.fn(async () => {
      throw new StripeApiError({ status: 500 });
    });
    const failingRepo = makeRepository({ customer: { stripe_customer_id: 'cus_1', user_id: USER, anonymized_at: null } });
    use(failing.gateway, failingRepo.repository);
    await expect(defaultAccountDeletionBilling.cancelForAccountDeletion(USER, makeLog().log, 'billing')).rejects.toBeInstanceOf(StripeApiError);
    expect(failing.calls).not.toContain('anonymizeCustomer:cus_1');
    expect(failingRepo.repository.markCustomerAnonymized).not.toHaveBeenCalled();
  });

  it('cancelForAccountDeletion expires open Checkout Sessions before listing and cancelling subscriptions (a session that completed between the list and the expire is skipped when re-retrieved as complete, and rethrown when still open); the billing_recheck pass cancels a subscription completed after the billing pass, anonymizes a customer created after it, does not re-anonymize an already anonymized customer, and audits only when it expired or cancelled something', async () => {
    // 1 回目 (billing): 開いた Session 2 つ (1 つは閉じる前に完了) を処理してから契約を列挙・解約する
    const stripe = makeStripe({
      subscriptions: [sub('sub_1', 'active')],
      openSessions: [session('cs_open', 'open'), session('cs_done', 'open')],
    });
    stripe.world.sessionStatusAtExpire.set('cs_done', 'complete');
    const repo = makeRepository({ customer: { stripe_customer_id: 'cus_1', user_id: USER, anonymized_at: null } });
    use(stripe.gateway, repo.repository);

    const first = await defaultAccountDeletionBilling.cancelForAccountDeletion(USER, makeLog().log, 'billing');
    expect(first).toEqual({ cancelled_subscriptions: 1, expired_checkout_sessions: 1, customer: 'anonymized' });
    const at = (call: string) => stripe.calls.indexOf(call);
    expect(at('expireCheckoutSession:cs_open')).toBeGreaterThanOrEqual(0);
    expect(at('expireCheckoutSession:cs_open')).toBeLessThan(at('listCustomerSubscriptions:cus_1'));
    expect(at('retrieveCheckoutSession:cs_done')).toBeLessThan(at('listCustomerSubscriptions:cus_1'));
    expect(at('listCustomerSubscriptions:cus_1')).toBeLessThan(at('cancelSubscriptionNow:sub_1'));
    expect(at('cancelSubscriptionNow:sub_1')).toBeLessThan(at('anonymizeCustomer:cus_1'));
    expect(repo.audits.map((entry) => entry.details)).toEqual([
      { phase: 'billing', cancelled_subscriptions: 1, expired_checkout_sessions: 1, stripe_customer_id: 'cus_1' },
    ]);
    const firstAnonymizedAt = repo.db.customer?.anonymized_at;
    expect(firstAnonymizedAt).toEqual(expect.any(String));

    // その間に cs_done の契約 (sub_2) が完了し、sub_1 は解約済みになった
    stripe.world.subscriptions = [sub('sub_1', 'canceled'), sub('sub_2', 'active')];
    stripe.calls.length = 0;

    // 2 回目 (billing_recheck): 段階 billing のあとに完了した契約を解約する。匿名化済みの顧客は匿名化を繰り返さない。監査は書く (解約あり)
    const second = await defaultAccountDeletionBilling.cancelForAccountDeletion(USER, makeLog().log, 'billing_recheck');
    expect(second).toEqual({ cancelled_subscriptions: 1, expired_checkout_sessions: 0, customer: 'anonymized' });
    expect(stripe.calls).toContain('cancelSubscriptionNow:sub_2');
    expect(stripe.calls).not.toContain('cancelSubscriptionNow:sub_1');
    expect(stripe.calls).not.toContain('anonymizeCustomer:cus_1');
    expect(repo.repository.markCustomerAnonymized).toHaveBeenCalledTimes(1);
    expect(repo.db.customer?.anonymized_at).toBe(firstAnonymizedAt);
    expect(repo.audits.map((entry) => entry.details)).toEqual([
      { phase: 'billing', cancelled_subscriptions: 1, expired_checkout_sessions: 1, stripe_customer_id: 'cus_1' },
      { phase: 'billing_recheck', cancelled_subscriptions: 1, expired_checkout_sessions: 0, stripe_customer_id: 'cus_1' },
    ]);

    // 3 回目 (billing_recheck のやり直し): 閉じるものも解約するものも無ければ、監査の行を増やさない
    stripe.world.subscriptions = [sub('sub_1', 'canceled'), sub('sub_2', 'canceled')];
    const third = await defaultAccountDeletionBilling.cancelForAccountDeletion(USER, makeLog().log, 'billing_recheck');
    expect(third).toEqual({ cancelled_subscriptions: 0, expired_checkout_sessions: 0, customer: 'anonymized' });
    expect(repo.audits).toHaveLength(2);

    // 段階 billing のあとに作られた顧客 (1 回目は顧客が無かった) は、billing_recheck で匿名化する
    const late = makeStripe({ subscriptions: [], openSessions: [session('cs_late', 'open')] });
    const lateRepo = makeRepository({ customer: null });
    use(late.gateway, lateRepo.repository);
    expect(await defaultAccountDeletionBilling.cancelForAccountDeletion(USER, makeLog().log, 'billing')).toEqual({
      cancelled_subscriptions: 0,
      expired_checkout_sessions: 0,
      customer: 'none',
    });
    lateRepo.db.customer = { stripe_customer_id: 'cus_late', user_id: USER, anonymized_at: null };
    late.world.subscriptions = [sub('sub_late', 'incomplete', 'cus_late')];
    expect(await defaultAccountDeletionBilling.cancelForAccountDeletion(USER, makeLog().log, 'billing_recheck')).toEqual({
      cancelled_subscriptions: 1,
      expired_checkout_sessions: 1,
      customer: 'anonymized',
    });
    expect(late.calls).toContain('anonymizeCustomer:cus_late');
    expect(late.calls).toContain('expireCheckoutSession:cs_late');
    expect(lateRepo.audits.map((entry) => entry.details)).toEqual([
      { phase: 'billing_recheck', cancelled_subscriptions: 1, expired_checkout_sessions: 1, stripe_customer_id: 'cus_late' },
    ]);

    // 段階 billing で、閉じられず open のままの Session があれば投げる (契約の列挙に進まない)
    const stuck = makeStripe({ subscriptions: [sub('sub_s', 'active')], openSessions: [session('cs_stuck', 'open')] });
    stuck.gateway.expireCheckoutSession = vi.fn(async () => {
      throw new StripeApiError({ status: 500 });
    });
    const stuckRepo = makeRepository({ customer: { stripe_customer_id: 'cus_1', user_id: USER, anonymized_at: null } });
    use(stuck.gateway, stuckRepo.repository);
    await expect(defaultAccountDeletionBilling.cancelForAccountDeletion(USER, makeLog().log, 'billing')).rejects.toBeInstanceOf(StripeApiError);
    expect(stuck.calls).not.toContain('listCustomerSubscriptions:cus_1');
    expect(stuck.calls).not.toContain('cancelSubscriptionNow:sub_s');
  });
});

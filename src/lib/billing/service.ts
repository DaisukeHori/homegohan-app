/**
 * 課金のユースケース (facade。billing/01 §8.6)。route はこれだけを呼ぶ。
 * stripe-gateway・repository・@/lib/env を import しない (実装は route が作って deps で渡す。Stripe を呼ばない GET の route が
 * AI の入口の棚卸しに載らないようにするため。billing/01 §2.2 F24)。
 */
import { createLogger } from '@/lib/db-logger';
import { getSiteUrl } from '@/lib/site-config';
import { getEffectivePlan } from '@/lib/plan/entitlements';
import {
  BILLING_PAGE_PATH,
  BillingError,
  StripeInvoiceRefSchema,
  buildCheckoutSessionParams,
  classifyStripeEvent,
  invoiceSubscriptionId,
  isPurchasable,
  isTerminalStripeStatus,
  priceIdFor,
  primaryPrice,
  projectSubscription,
  resolvePlanKey,
  summarizeSubscription,
  trialDaysFor,
  type ApplySubscriptionResult,
  type BillingAuditEntry,
  type BillingRepository,
  type BillingSummary,
  type BillingInterval,
  type StripeEventEnvelope,
  type StripeGateway,
} from '@/lib/billing/core';

const logger = createLogger('billing/service');

/**
 * Stripe を呼ばないユースケース (確認画面の内容・契約の要約) の依存。gateway を持たないので、route は createStripeGateway を
 * 呼ばず (= import せず)、鍵 (STRIPE_SECRET_KEY) が無くても 200 を返す (S11)
 */
export interface BillingReadDeps {
  repository: BillingRepository;
  /** テストで差し替える (いま)。既定は () => new Date() */
  now?: () => Date;
}

/** Stripe を呼ぶユースケースの依存 (route が createStripeGateway() で作る。鍵が無ければ StripeNotConfiguredError → 503) */
export interface BillingDeps extends BillingReadDeps {
  gateway: StripeGateway;
}

export interface CheckoutPreview {
  plan_key: string;
  display_name: string;
  interval: BillingInterval;
  amount_jpy: number;
  trial_days: number;
  can_purchase: boolean;
}

/** 監査は fail-open (閲覧ログと同じ)。失敗はログに残し、本体の操作は止めない */
async function audit(repository: BillingRepository, entry: BillingAuditEntry): Promise<void> {
  try {
    await repository.recordAudit(entry);
  } catch (error) {
    logger.error('課金の監査ログの記録に失敗しました', error, { action_type: entry.action_type });
  }
}

/** 特商法の確認画面に出す内容 (GET /api/billing/checkout/preview)。Stripe は呼ばない (gateway を受け取らない) */
export async function previewCheckout(deps: BillingReadDeps, userId: string, planKey: string, interval: BillingInterval): Promise<CheckoutPreview> {
  const plan = await deps.repository.findPlan(planKey);
  if (!plan || !isPurchasable(plan, interval)) throw new BillingError('BILL_PLAN_NOT_PURCHASABLE');
  const live = await deps.repository.findLiveSubscription(userId);
  const trialUsed = await deps.repository.hasUsedTrial(userId, planKey);
  const amount = interval === 'month' ? plan.monthly_price_jpy : plan.yearly_price_jpy;
  return {
    plan_key: plan.plan_key,
    display_name: plan.display_name,
    interval,
    amount_jpy: amount ?? 0,
    trial_days: trialDaysFor(plan.trial_days, trialUsed),
    can_purchase: live === null,
  };
}

/** Checkout Session を作り、その URL を返す (POST /api/billing/checkout) */
export async function startCheckout(
  deps: BillingDeps,
  user: { id: string; email: string | null },
  planKey: string,
  interval: BillingInterval,
): Promise<{ url: string; session_id: string }> {
  const plan = await deps.repository.findPlan(planKey);
  if (!plan || !isPurchasable(plan, interval)) throw new BillingError('BILL_PLAN_NOT_PURCHASABLE');
  const priceId = priceIdFor(plan, interval);
  if (priceId === null) throw new BillingError('BILL_PLAN_NOT_PURCHASABLE');
  if ((await deps.repository.findLiveSubscription(user.id)) !== null) throw new BillingError('OP_SUBSCRIPTION_ALREADY_ACTIVE');
  const trialDays = trialDaysFor(plan.trial_days, await deps.repository.hasUsedTrial(user.id, planKey));

  let customer = await deps.repository.findCustomer(user.id);
  if (customer === null) {
    const created = await deps.gateway.createCustomer({ userId: user.id, email: user.email });
    customer = await deps.repository.saveCustomer(user.id, created.id);
  }

  const session = await deps.gateway.createCheckoutSession(
    buildCheckoutSessionParams({ customerId: customer.stripe_customer_id, userId: user.id, planKey, interval, priceId, trialDays, siteUrl: getSiteUrl() }),
  );
  if (!session.url) throw new BillingError('EXT_STRIPE_API_FAILED');
  await audit(deps.repository, {
    actor_id: user.id, action_type: 'user.billing.checkout_started', target_type: 'user', target_id: user.id, severity: 'info',
    details: { plan_key: planKey, interval, trial_days: trialDays, checkout_session_id: session.id },
  });
  return { url: session.url, session_id: session.id };
}

/**
 * Stripe から最新の Subscription を取り直して写す (すべての写しの入口。Webhook・戻り画面・解約 API・配線の reconcile)。
 * 写像が「退会済み」で、契約の顧客が退会した利用者のもの (customer_closed) なのに Stripe の契約が終端でなければ、Stripe で即時解約する
 * (退会の段階 billing_recheck のあと deleteUser までに完了した Checkout の契約など。退会の前に開いた Checkout は退会の段階が閉じる。§7.3 の退会済みの行・§11)。
 * 解約に失敗したら例外 (Webhook は failed・500 で Stripe が再送し、取り直しで同じ判定をやり直す)。解約のあとに届く deleted は終端なので何もしない
 */
export async function syncSubscription(deps: BillingDeps, subscriptionId: string, source: string): Promise<ApplySubscriptionResult> {
  const fetchedAt = (deps.now ?? (() => new Date()))();
  const sub = await deps.gateway.retrieveSubscription(subscriptionId);
  // findPlanKeyByPriceId を呼ぶのは metadata.plan_key が無いときだけ (Dashboard で作られた契約。S13)
  const { priceId } = primaryPrice(sub);
  const planKeyByPrice = priceId !== null && !sub.metadata?.plan_key ? await deps.repository.findPlanKeyByPriceId(priceId) : null;
  const snapshot = projectSubscription(sub, resolvePlanKey(sub, planKeyByPrice));
  const result = await deps.repository.applyStripeSubscription({ snapshot, fetchedAt, source });
  if (!result.applied && result.skipped === 'user_deleted' && result.customer_closed && !isTerminalStripeStatus(sub.status)) {
    await deps.gateway.cancelSubscriptionNow(sub.id);
    await audit(deps.repository, {
      actor_id: null, action_type: 'system.billing.orphan_subscription_cancelled', target_type: 'stripe_subscription', target_id: null,
      severity: 'warn', details: { stripe_subscription_id: sub.id, stripe_status: sub.status, source },
    });
  }
  return result;
}

/** 戻り画面からの同期 (POST /api/billing/checkout/sync)。Session の持ち主が本人でなければ 403 */
export async function syncCheckoutSession(deps: BillingDeps, userId: string, sessionId: string): Promise<BillingSummary> {
  const session = await deps.gateway.retrieveCheckoutSession(sessionId);
  if (session.client_reference_id !== userId) throw new BillingError('BILL_CHECKOUT_SESSION_MISMATCH');
  if (session.status === 'complete' && session.subscription) {
    await syncSubscription(deps, session.subscription, 'checkout_sync');
  }
  return getBillingSummary(deps, userId);
}

/** 契約の要約 (GET /api/billing/subscription と、ほかのユースケースの戻り値)。Stripe は呼ばない (gateway を受け取らない) */
export async function getBillingSummary(deps: BillingReadDeps, userId: string): Promise<BillingSummary> {
  const [row, customer, effectivePlanKey] = await Promise.all([
    deps.repository.findLiveSubscription(userId),
    deps.repository.findCustomer(userId),
    getEffectivePlan(userId),
  ]);
  // いま効いているプランの AI の上限 (画面の錠と案内。billing/03 §8.6)
  const features = await deps.repository.findPlanFeatures(effectivePlanKey);
  return summarizeSubscription(row, customer !== null, effectivePlanKey, features);
}

export async function createPortalSession(deps: BillingDeps, userId: string): Promise<{ url: string }> {
  const customer = await deps.repository.findCustomer(userId);
  if (customer === null) throw new BillingError('BILL_CUSTOMER_NOT_FOUND');
  return deps.gateway.createBillingPortalSession({ customerId: customer.stripe_customer_id, returnUrl: `${getSiteUrl()}${BILLING_PAGE_PATH}` });
}

/** 期間末での解約を予約する (冪等: 予約済みならそのまま要約を返す) */
export async function scheduleCancellation(deps: BillingDeps, userId: string): Promise<BillingSummary> {
  const row = await deps.repository.findLiveSubscription(userId);
  if (row === null || row.stripe_subscription_id === null) throw new BillingError('BILL_NO_LIVE_SUBSCRIPTION');
  if (!row.cancel_at_period_end) {
    const fetchedAt = (deps.now ?? (() => new Date()))();
    const sub = await deps.gateway.updateCancelAtPeriodEnd(row.stripe_subscription_id, true);
    await deps.repository.applyStripeSubscription({ snapshot: projectSubscription(sub, row.plan_key), fetchedAt, source: 'api:cancel' });
    await audit(deps.repository, {
      actor_id: userId, action_type: 'user.billing.cancel_scheduled', target_type: 'user', target_id: userId, severity: 'info',
      details: { stripe_subscription_id: row.stripe_subscription_id, plan_key: row.plan_key },
    });
  }
  return getBillingSummary(deps, userId);
}

/** 解約の予約を取り消す (予約が無ければ 409) */
export async function revokeCancellation(deps: BillingDeps, userId: string): Promise<BillingSummary> {
  const row = await deps.repository.findLiveSubscription(userId);
  if (row === null || row.stripe_subscription_id === null) throw new BillingError('BILL_NO_LIVE_SUBSCRIPTION');
  if (!row.cancel_at_period_end) throw new BillingError('BILL_CANCEL_NOT_SCHEDULED');
  const fetchedAt = (deps.now ?? (() => new Date()))();
  const sub = await deps.gateway.updateCancelAtPeriodEnd(row.stripe_subscription_id, false);
  await deps.repository.applyStripeSubscription({ snapshot: projectSubscription(sub, row.plan_key), fetchedAt, source: 'api:resume' });
  await audit(deps.repository, {
    actor_id: userId, action_type: 'user.billing.cancel_revoked', target_type: 'user', target_id: userId, severity: 'info',
    details: { stripe_subscription_id: row.stripe_subscription_id, plan_key: row.plan_key },
  });
  return getBillingSummary(deps, userId);
}

export type StripeEventOutcome = { action: 'synced' | 'ignored' | 'skipped'; detail: string };

/**
 * 処理に失敗したイベントを記録する (POST /api/webhooks/stripe の catch。§9.6 の 8)。
 * finish(ok=false) の失敗は投げる (route が 500。行は processing のまま残り、15 分後の再送で取り直す)。
 * 監査は利用者を解決できないことがあるので target は stripe_event (target_id = NULL)。fail-open
 */
export async function recordStripeEventFailure(deps: BillingDeps, event: StripeEventEnvelope, errorCode: string): Promise<void> {
  await deps.repository.finishStripeEvent(event.id, { ok: false, errorCode });
  await audit(deps.repository, {
    actor_id: null, action_type: 'system.stripe.event_failed', target_type: 'stripe_event', target_id: null, severity: 'warn',
    details: { event_id: event.id, event_type: event.type, error_code: errorCode },
  });
}

/**
 * 署名と claim を通ったイベントを処理する (POST /api/webhooks/stripe)。例外は route が finish(ok=false) + 500 にする。
 * data.object から使うのは、写しを決めるための id と (invoice の) subscription の参照 (§4.1) と、invoice.payment_failed の
 * 監査 system.payment.failed の details に入れる請求の id・attempt_count・amount_due だけ (この 3 つは写しには書かない。§8.2・テスト 33)。
 */
export async function handleStripeEvent(deps: BillingDeps, event: StripeEventEnvelope): Promise<StripeEventOutcome> {
  const source = `webhook:${event.id}`;
  const action = classifyStripeEvent(event.type);
  const objectId = event.data.object.id ?? null;
  switch (action) {
    case 'ignore':
      return { action: 'ignored', detail: event.type };
    case 'sync_checkout_session': {
      if (objectId === null) return { action: 'skipped', detail: 'no_object_id' };
      const session = await deps.gateway.retrieveCheckoutSession(objectId);
      if (session.mode !== 'subscription' || !session.subscription) return { action: 'skipped', detail: 'not_subscription_session' };
      const result = await syncSubscription(deps, session.subscription, source);
      return { action: result.applied ? 'synced' : 'skipped', detail: result.applied ? result.status_to : result.skipped };
    }
    case 'sync_subscription': {
      if (objectId === null) return { action: 'skipped', detail: 'no_object_id' };
      const result = await syncSubscription(deps, objectId, source);
      return { action: result.applied ? 'synced' : 'skipped', detail: result.applied ? result.status_to : result.skipped };
    }
    case 'sync_invoice_subscription':
    case 'audit_payment_failed_and_sync': {
      const invoice = StripeInvoiceRefSchema.safeParse(event.data.object);
      const subscriptionId = invoice.success ? invoiceSubscriptionId(invoice.data) : null;
      if (subscriptionId === null) return { action: 'skipped', detail: 'invoice_without_subscription' };
      const result = await syncSubscription(deps, subscriptionId, source);
      // 支払失敗の監査は、写像が古い取り直しで stale になっても書く (invoice.payment_failed と customer.subscription.updated は
      // ほぼ同時に届き、updated 側の新しい取り直しが先に commit すると、こちらは stale になる。S8(e))。書かないのは退会済みだけ。
      // 写像のあとに書く (先に書くと、写像の失敗の再処理で同じ監査が 2 行になる)
      const auditUserId = result.applied || result.skipped === 'stale' ? result.user_id : null;
      if (action === 'audit_payment_failed_and_sync' && auditUserId !== null) {
        await audit(deps.repository, {
          actor_id: null, action_type: 'system.payment.failed', target_type: 'user', target_id: auditUserId, severity: 'warn',
          details: {
            stripe_subscription_id: subscriptionId, invoice_id: invoice.success ? invoice.data.id : null,
            attempt_count: invoice.success ? (invoice.data.attempt_count ?? null) : null,
            amount_due: invoice.success ? (invoice.data.amount_due ?? null) : null, event_id: event.id,
          },
        });
      }
      return { action: result.applied ? 'synced' : 'skipped', detail: result.applied ? result.status_to : result.skipped };
    }
  }
}

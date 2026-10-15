/**
 * 退会の段階 billing / billing_recheck の実装 (billing/01 §11)。開いたままの Checkout Session を閉じ、
 * Stripe の契約を即時解約し、顧客を匿名化する。
 */
import { createStripeGateway } from '@/lib/billing/stripe-gateway';
import { createBillingRepository } from '@/lib/billing/repository';
import { isTerminalStripeStatus, type StripeGateway, type StripeSubscription } from '@/lib/billing/core';
import type {
  AccountDeletionBilling,
  AccountDeletionBillingLogger,
  AccountDeletionBillingPhase,
  AccountDeletionBillingReport,
} from '@/lib/account-deletion';

/**
 * 退会で解約する契約を集める。DB の行だけでは足りない (Webhook が着く前の契約・写像が BILL_LIVE_ROW_CONFLICT /
 * BILL_UNKNOWN_PLAN で失敗した契約は行が無い) ので、(1) 顧客の全契約を Stripe から列挙し、(2) DB の行のうち (1) に無いもの
 * (別の顧客で作られた契約) を Stripe から取り直して足す。終端 (canceled / incomplete_expired) は除く。
 */
export async function collectSubscriptionsToCancel(
  gateway: StripeGateway,
  customerId: string | null,
  knownSubscriptionIds: readonly string[],
): Promise<StripeSubscription[]> {
  const byId = new Map<string, StripeSubscription>();
  if (customerId !== null) {
    for (const sub of await gateway.listCustomerSubscriptions(customerId)) byId.set(sub.id, sub);
  }
  for (const id of knownSubscriptionIds) {
    if (!byId.has(id)) byId.set(id, await gateway.retrieveSubscription(id));
  }
  return [...byId.values()].filter((sub) => !isTerminalStripeStatus(sub.status));
}

/**
 * 顧客の開いたままの Checkout Session を全部閉じ、閉じた数を返す。契約の列挙より先に呼ぶ (閉じたあとは、その Session から契約が生まれない)。
 * 列挙してから閉じるまでの間に完了 (または期限切れ) になった Session は閉じられない (Stripe が 4xx)。そのときは Session を取り直し、
 * もう open でなければ飛ばす (完了した Session の契約は、このあとの契約の列挙 (2) に出て解約される)。open のままなら投げる (その段階で止める)
 */
export async function expireOpenCheckoutSessions(gateway: StripeGateway, customerId: string): Promise<number> {
  let expired = 0;
  for (const session of await gateway.listOpenCheckoutSessions(customerId)) {
    try {
      await gateway.expireCheckoutSession(session.id);
      expired += 1;
    } catch (error) {
      const current = await gateway.retrieveCheckoutSession(session.id);
      if (current.status === 'open') throw error;
    }
  }
  return expired;
}

export const defaultAccountDeletionBilling: AccountDeletionBilling = {
  async cancelForAccountDeletion(
    userId: string,
    log: AccountDeletionBillingLogger,
    phase: AccountDeletionBillingPhase,
  ): Promise<AccountDeletionBillingReport> {
    const repository = createBillingRepository();
    const customer = await repository.findCustomer(userId);
    const knownRows = await repository.listStripeBackedSubscriptions(userId);
    if (customer === null && knownRows.length === 0) return { cancelled_subscriptions: 0, expired_checkout_sessions: 0, customer: 'none' };
    // 顧客か契約があるのに鍵が無ければ、解約の義務を果たせないので止める (StripeNotConfiguredError → その段階の 500)
    const gateway = createStripeGateway();
    // (1) 開いたままの Checkout を先に閉じる
    const expired = customer === null ? 0 : await expireOpenCheckoutSessions(gateway, customer.stripe_customer_id);
    // (2) 終端でない契約を即時解約する
    let cancelled = 0;
    const knownIds = knownRows.map((row) => row.stripe_subscription_id);
    for (const sub of await collectSubscriptionsToCancel(gateway, customer?.stripe_customer_id ?? null, knownIds)) {
      await gateway.cancelSubscriptionNow(sub.id);
      cancelled += 1;
    }
    if (customer === null) {
      log.info('account deletion: stripe subscriptions cancelled (no billing customer row)', { phase, cancelled_subscriptions: cancelled });
      return { cancelled_subscriptions: cancelled, expired_checkout_sessions: 0, customer: 'none' };
    }
    // (3) 顧客を匿名化する。匿名化済み (1 回目の段階 billing・前の退会の試み) なら Stripe も DB もそのまま (anonymized_at は最初の時刻を保つ)。
    //     段階 billing のあとで作られた顧客 (1 回目は顧客が無かった) は、2 回目 (billing_recheck) でここを通る
    if (customer.anonymized_at === null) {
      const anonymizedAt = new Date().toISOString();
      await gateway.anonymizeCustomer(customer.stripe_customer_id, anonymizedAt);
      await repository.markCustomerAnonymized(customer.stripe_customer_id, anonymizedAt);
    }
    // 監査: 1 回目 (billing) は必ず書く。2 回目 (billing_recheck) は閉じた Session・解約した契約があったときだけ書く (無ければ行を増やさない)
    if (phase === 'billing' || cancelled + expired > 0) {
      await repository.recordAudit({
        // system.* なので actor_id は NULL (§8.1 の規則。退会の操作そのものの記録は deleteAccount のログにある)
        actor_id: null, action_type: 'system.billing.account_deletion_stripe_cancelled', target_type: 'user', target_id: userId, severity: 'info',
        details: { phase, cancelled_subscriptions: cancelled, expired_checkout_sessions: expired, stripe_customer_id: customer.stripe_customer_id },
      });
    }
    log.info('account deletion: checkout sessions expired, stripe subscriptions cancelled and customer anonymized', {
      phase, cancelled_subscriptions: cancelled, expired_checkout_sessions: expired,
    });
    return { cancelled_subscriptions: cancelled, expired_checkout_sessions: expired, customer: 'anonymized' };
  },
};

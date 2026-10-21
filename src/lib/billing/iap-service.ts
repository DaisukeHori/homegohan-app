/**
 * アプリ内課金のユースケース (billing/03 §8.4)。revenuecat-gateway・iap-repository・@/lib/env を import しない (実装は route が作って deps で渡す)。
 */
import { createLogger } from '@/lib/db-logger';
import { BillingRpcError } from '@/lib/billing/repository';
import {
  IAP_LAZY_RESYNC_SOURCE,
  IapError,
  appUserIdsToSync,
  isLiveStoreRowStatus,
  needsLazyResync,
  projectMissingSubscription,
  projectStoreSubscription,
  revenueCatWebhookSource,
  selectStoreSubscriptions,
  storeSubscriptionKey,
  supersededStoreSource,
  unmappedStoreSubscriptionDecision,
  type IapRepository,
  type RevenueCatEvent,
  type RevenueCatGateway,
  type StoreSyncOutcome,
} from '@/lib/billing/iap-core';

const logger = createLogger('billing/iap-service');

export interface IapDeps {
  gateway: RevenueCatGateway;
  repository: IapRepository;
  /** テストで差し替える (いま)。既定は () => new Date() */
  now?: () => Date;
}

/** 監査は fail-open (核と同じ)。失敗はログに残し、本体の操作は止めない */
async function audit(repository: IapRepository, entry: Parameters<IapRepository['recordIapAudit']>[0]): Promise<void> {
  try {
    await repository.recordIapAudit(entry);
  } catch (error) {
    logger.error('アプリ内課金の監査ログの記録に失敗しました', error, { action_type: entry.action_type });
  }
}

/**
 * 利用者 1 人のストアの契約を RevenueCat から取り直して写す (すべての写しの入口。Webhook・同期の API・遅延の再同期)。
 *   1. GET /v1/subscribers/{user id} → 本冊のストアの契約を適用する順に並べる (live でないもの・同じ App Store のグループの新しい購読に
 *      置き換えられたもの (supersededAt。§7.3・S36) が先)
 *   2. 利用者のストアの行を全部読む。plan_store_products に対応の行が無い商品は unmappedStoreSubscriptionDecision で振り分ける:
 *      利用者の行があれば写す (SQL がその行の plan_key を使う)・無くて live なら BILL_IAP_UNKNOWN_PRODUCT (何も書かずに止める。
 *      運営が行を足したあとの同期で写る。S15)・無くて live でなければ飛ばす (S28)
 *   3. 取り直した subscriptions に無い live なストアの行 (TRANSFER で移った・消えた) は expired の snapshot で終わらせる
 *      (行の iap_is_sandbox と billing_interval を引き継ぐ)
 *   4. 1 件ずつ billing_apply_store_subscription。置き換えられた購読は expired の snapshot と p_source = <source>:superseded で写す。
 *      BILL_LIVE_ROW_CONFLICT はそのまま投げる (route が 409 / failed にする。S13)
 */
export async function syncStoreSubscriber(deps: IapDeps, userId: string, source: string): Promise<StoreSyncOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const info = await deps.gateway.getSubscriber(userId);
  const products = await deps.repository.listStoreProducts();
  const selected = selectStoreSubscriptions(info, products, nowMs);
  const rows = await deps.repository.listStoreSubscriptions(userId);
  const existing = new Set(rows.map((row) => storeSubscriptionKey(row.iap_store, row.iap_product_id)));
  const toApply: typeof selected = [];
  let skippedUnknown = 0;
  for (const entry of selected) {
    const decision = unmappedStoreSubscriptionDecision(entry, existing.has(storeSubscriptionKey(entry.store, entry.productId)), nowMs);
    // 書き込みの前に判定する (1 つでも reject なら、どの行も書かずに止める。運営が行を足したあとの同期で全部を写す)
    if (decision === 'reject') throw new IapError('BILL_IAP_UNKNOWN_PRODUCT');
    if (decision === 'skip') skippedUnknown += 1;
    else toApply.push(entry);
  }
  const outcome: StoreSyncOutcome = {
    user_id: userId, applied: 0, stale: 0, no_subscription: selected.length === 0, ended: 0, skipped_unknown: skippedUnknown,
  };

  const present = new Set(selected.map((entry) => storeSubscriptionKey(entry.store, entry.productId)));
  for (const row of rows) {
    if (!isLiveStoreRowStatus(row.status) || present.has(storeSubscriptionKey(row.iap_store, row.iap_product_id))) continue;
    const snapshot = projectMissingSubscription({
      userId, store: row.iap_store, productId: row.iap_product_id, planKey: row.plan_key,
      purchaseDate: row.current_period_start ?? row.starts_at,
      isSandbox: row.iap_is_sandbox, billingInterval: row.billing_interval, nowMs,
    });
    const result = await deps.repository.applyStoreSubscription({ snapshot, fetchedAt: now, source });
    if (result.applied) outcome.ended += 1;
  }
  for (const entry of toApply) {
    const snapshot = projectStoreSubscription({
      userId, store: entry.store, productId: entry.productId, sub: entry.sub, mapping: entry.mapping, supersededAt: entry.supersededAt, nowMs,
    });
    // 置き換えによる終わりは、監査の details.source で見分けられるように印を付ける (§13.3 の運営の処置)
    const entrySource = entry.supersededAt === null ? source : supersededStoreSource(source);
    const result = await deps.repository.applyStoreSubscription({ snapshot, fetchedAt: now, source: entrySource });
    if (result.applied) outcome.applied += 1;
    else if (result.skipped === 'stale') outcome.stale += 1;
  }
  return outcome;
}

export type RevenueCatEventOutcome = { action: 'synced' | 'ignored'; detail: string };

/** 署名と claim を通ったイベントを処理する (POST /api/webhooks/revenuecat)。例外は route が finish(ok=false) + 500 にする */
export async function handleRevenueCatEvent(deps: IapDeps, event: RevenueCatEvent): Promise<RevenueCatEventOutcome> {
  const userIds = appUserIdsToSync(event);
  if (userIds.length === 0) return { action: 'ignored', detail: event.type };
  const source = revenueCatWebhookSource(event.id);
  const details: string[] = [];
  for (const userId of userIds) {
    const outcome = await syncStoreSubscriber(deps, userId, source);
    details.push(`${outcome.applied}/${outcome.stale}/${outcome.ended}/${outcome.skipped_unknown}${outcome.no_subscription ? '/none' : ''}`);
  }
  return { action: 'synced', detail: details.join(',') };
}

/** 処理に失敗したイベントを記録する (route の catch)。finish(ok=false) の失敗は投げる (route が 500) */
export async function recordRevenueCatEventFailure(deps: IapDeps, event: RevenueCatEvent, errorCode: string): Promise<void> {
  await deps.repository.finishRevenueCatEvent(event.id, { ok: false, errorCode });
  await audit(deps.repository, {
    actor_id: null, action_type: 'system.revenuecat.event_failed', target_type: 'revenuecat_event', target_id: null, severity: 'warn',
    details: { event_id: event.id, event_type: event.type, error_code: errorCode },
  });
}

/**
 * 遅延の再同期 (GET /api/billing/subscription の前。Q-11・S12)。期限を過ぎたストアの行で、5 分より古い取り直しなら取り直す。
 * 失敗しても要約の読み取りは止めない (ログに残す)。鍵が無い (RevenueCatNotConfiguredError) ときは呼び出し側が deps を作れないので、ここには来ない
 */
export async function lazyResyncStoreSubscription(
  deps: IapDeps,
  userId: string,
  row: { iap_store: string | null; current_period_end: string | null; iap_synced_at: string | null } | null,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  if (!needsLazyResync(row, now.getTime())) return;
  try {
    await syncStoreSubscriber(deps, userId, IAP_LAZY_RESYNC_SOURCE);
  } catch (error) {
    // 取り直せなくても、いまの行で要約を返す (次の読み取りでまた試す)
    logger.warn('ストアの契約の遅延の再同期に失敗しました', { user_id: userId, code: error instanceof BillingRpcError ? error.code : error instanceof IapError ? error.code : 'unknown' });
  }
}

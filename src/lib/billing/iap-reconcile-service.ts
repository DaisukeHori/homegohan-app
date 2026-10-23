/**
 * ストアの購読の定期の取り直し (billing/04 §8.3)。候補の利用者を 1 人ずつ syncStoreSubscriber (billing/03 §8.4。写しの唯一の TS の入口) で
 * 取り直す。revenuecat-gateway・iap-repository・iap-reconcile-repository・@/lib/env を import しない (実装は route が作って deps で渡す)。
 *   - 1 人ずつ直列。取り直しの開始の間隔は IAP_RECONCILE_REQUEST_INTERVAL_MS (1 秒)。予算 IAP_RECONCILE_RUN_BUDGET_MS (40 秒) で打ち切る
 *   - 運営の処置が要る利用者 (BillingRpcError の BILL_LIVE_ROW_CONFLICT・IapError の BILL_IAP_UNKNOWN_PRODUCT = IAP_RECONCILE_REJECTED_CODES) は
 *     rejected に数えて次へ (warn。候補に残り、次の回は後ろに回る)。ほかの業務エラー (BILL_UNKNOWN_PLAN・BILL_UNKNOWN_IAP_STATUS) は下の user (internal)
 *   - それ以外の失敗は classifyReconcileFailure で分ける:
 *       rate_limited (429)  → その回を止める (stopped_early = 'rate_limited'。残りは次の回)
 *       run (届かない・401 / 403・5xx) → failed に数えてその回を止める (stopped_early = 'revenuecat_unavailable')
 *       user (応答の形の違い・そのほかの 4xx・RevenueCatApiError 以外 (上の 2 つ以外の業務エラーを含む)) → failed に数えて次の利用者へ
 *   - ループの後、この回に syncStoreSubscriber を呼んだ利用者 (結果を問わない) にだけ、1 回の RPC で印を書く (markReconcileAttempted)。
 *     選んだのに予算・429・回全体の失敗で試さなかった利用者は渡さない (印が進まず、次の回で試した利用者より先に選ばれる。billing/04 S18)
 *   - 回の終わりに failed が 1 以上なら IapReconcileFailedError を投げる (route が 500 → 失敗の監視)
 *   - 候補を読む RPC・印を書く RPC の失敗はそのまま投げる (route が 500)
 */
import { createLogger } from '@/lib/db-logger';
import { BillingRpcError } from '@/lib/billing/repository';
import { IapError, RevenueCatApiError } from '@/lib/billing/iap-core';
import { syncStoreSubscriber, type IapDeps } from '@/lib/billing/iap-service';
import {
  IAP_RECONCILE_SOURCE,
  IapReconcileFailedError,
  classifyReconcileFailure,
  countReconcileFailures,
  emptyIapReconcileSummary,
  isIapReconcileRejectedCode,
  isReconcileBudgetExhausted,
  reconcileFetchDelayMs,
  type IapReconcileRejectedCode,
  type IapReconcileRepository,
  type IapReconcileSettings,
  type IapReconcileSummary,
} from '@/lib/billing/iap-reconcile-core';

const logger = createLogger('billing/iap-reconcile-service');

export interface IapReconcileDeps extends IapDeps {
  reconcileRepository: IapReconcileRepository;
  /** テストで差し替える (待ち)。既定は setTimeout */
  sleep?: (ms: number) => Promise<void>;
}
export type IapReconcileRunSettings = Pick<IapReconcileSettings, 'batchSize' | 'recheckHours'>;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** ログに残す例外の名前とコード (文面は残さない。PostgrestError の code = SQLSTATE など) */
function errorFingerprint(error: unknown): { error_name: string | null; error_code: string | null } {
  const name = error instanceof Error ? error.name : null;
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null;
  return { error_name: name, error_code: code };
}

/** 運営の処置が要る業務エラー (IAP_RECONCILE_REJECTED_CODES) ならそのコード、それ以外 (BILL_UNKNOWN_PLAN などを含む) は null */
function rejectedCodeOf(error: unknown): IapReconcileRejectedCode | null {
  if (!(error instanceof BillingRpcError) && !(error instanceof IapError)) return null;
  const { code } = error;
  return isIapReconcileRejectedCode(code) ? code : null;
}

/**
 * 1 回の処理。候補を読む → 1 人ずつ取り直す → 試した利用者に印を書く → 要約を返す (取り直せなかった利用者がいれば IapReconcileFailedError を投げる)。
 * 取り直しの p_fetched_at は syncStoreSubscriber が GET の前に取る (ここでは取らない)。候補の判定の p_now と印の時刻は、処理の開始に 1 回取る
 */
export async function reconcileStoreSubscriptions(deps: IapReconcileDeps, settings: IapReconcileRunSettings): Promise<IapReconcileSummary> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const startedAtMs = now().getTime();
  const startedAt = new Date(startedAtMs);
  const candidates = await deps.reconcileRepository.listReconcileCandidates({
    now: startedAt,
    recheckHours: settings.recheckHours,
    limit: settings.batchSize,
  });
  const summary = emptyIapReconcileSummary(candidates);
  /** この回に syncStoreSubscriber を呼んだ利用者 (結果を問わない)。ループの後に印を書く。選んだのに試さなかった利用者は入れない */
  const attemptedUserIds: string[] = [];
  let lastFetchStartedAtMs: number | null = null;
  for (const candidate of candidates) {
    if (isReconcileBudgetExhausted(startedAtMs, now().getTime())) {
      summary.stopped_early = 'budget';
      break;
    }
    const delay = reconcileFetchDelayMs(lastFetchStartedAtMs, now().getTime());
    if (delay > 0) await sleep(delay);
    lastFetchStartedAtMs = now().getTime();
    attemptedUserIds.push(candidate.user_id);
    try {
      const outcome = await syncStoreSubscriber(deps, candidate.user_id, IAP_RECONCILE_SOURCE);
      summary.synced += 1;
      summary.applied += outcome.applied;
      summary.stale += outcome.stale;
      summary.ended += outcome.ended;
      summary.skipped_unknown += outcome.skipped_unknown;
      if (outcome.no_subscription) summary.no_subscription += 1;
    } catch (error) {
      const rejectedCode = rejectedCodeOf(error);
      if (rejectedCode !== null) {
        // 別の live 行との衝突・対応の無い商品 (billing/03 §13.3・S15 の運営の処置)。この利用者は飛ばす (候補に残り、印で次の回は後ろに回る)
        summary.rejected[rejectedCode] = (summary.rejected[rejectedCode] ?? 0) + 1;
        logger.warn('ストアの購読の取り直しを写せませんでした (運営の処置が要ります)', { user_id: candidate.user_id, code: rejectedCode });
        continue;
      }
      // BILL_UNKNOWN_PLAN・BILL_UNKNOWN_IAP_STATUS の BillingRpcError は source other → user (internal)。warn の error_code にコードが残る
      const failure = classifyReconcileFailure(
        error instanceof RevenueCatApiError ? { source: 'revenuecat', status: error.status } : { source: 'other' },
      );
      if (failure.scope === 'rate_limited') {
        // 率の制限。止めて次の回に回す (RevenueCat の案内「止めて再試行」。billing/04 §2.3 P1)。この利用者は試した利用者 (印を書く)、後ろは試さない
        summary.stopped_early = 'rate_limited';
        logger.warn('RevenueCat の率の制限 (429) のため、この回の取り直しを止めました (残りは次の回)', {
          candidates: summary.candidates,
          synced: summary.synced,
        });
        break;
      }
      summary.failed[failure.kind] = (summary.failed[failure.kind] ?? 0) + 1;
      logger.warn('ストアの購読を取り直せませんでした', {
        user_id: candidate.user_id,
        kind: failure.kind,
        scope: failure.scope,
        ...errorFingerprint(error),
      });
      if (failure.scope === 'run') {
        // 回全体の失敗 (届かない・鍵の誤り・5xx): 次の利用者でも同じになるので、この回を止める (この利用者は印で後ろに回る。毎回同じ利用者で止まらない)
        summary.stopped_early = 'revenuecat_unavailable';
        break;
      }
      // 利用者 1 人の失敗: 後ろの利用者を止めない (この利用者は候補に残り、印で次の回は後ろに回る)
    }
  }
  if (attemptedUserIds.length > 0) {
    // 試した利用者にだけ印を書く (1 回の RPC)。失敗はそのまま投げる (取り直しと写しは済んでいる。route が 500)
    await deps.reconcileRepository.markReconcileAttempted({ userIds: attemptedUserIds, attemptedAt: startedAt });
  }
  summary.elapsed_ms = now().getTime() - startedAtMs;
  if (countReconcileFailures(summary) > 0) {
    // 取り直せなかった利用者がいる回は失敗として終える (route が 500 → 失敗の監視)。件数は warn と route の error の両方に残る
    logger.warn('取り直せなかった利用者がいるため、この回を失敗として終えます', { ...summary });
    throw new IapReconcileFailedError(summary);
  }
  return summary;
}

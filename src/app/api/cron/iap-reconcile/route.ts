/**
 * GET /api/cron/iap-reconcile — 期限を過ぎた live なストアの購読の行を RevenueCat から取り直して写す (Vercel Cron。毎時 41 分。billing/04 §9)
 *
 * Webhook の再送 (5 回・約 80 分) が尽きて写らなかった失効・更新を、本人の操作が無くても期限の後 1 時間以内に personal_subscriptions に写す。
 * 本体は src/lib/billing/iap-reconcile-service.ts の reconcileStoreSubscriptions、候補と試した利用者の印は DB の関数 billing_iap_reconcile_candidates /
 * billing_iap_reconcile_mark_attempted (src/lib/billing/iap-reconcile-repository.ts)、取り直しと写像は billing/03 の syncStoreSubscriber → billing_apply_store_subscription。
 *
 * - 認証: Vercel Cron が付ける `Authorization: Bearer <CRON_SECRET>` (src/lib/cron-auth.ts の requireCronAuth)。
 * - メンテナンス中は何もせず次の回に回す (push-outbox と同じ)。
 * - REVENUECAT_SECRET_API_KEY が未設定なら何もしない (DB にも触れない。変数名は warn のログにだけ書き、応答には出さない)。
 * - IAP_RECONCILE_BATCH_SIZE / IAP_RECONCILE_RECHECK_HOURS で 1 回の件数と再確認の間隔を上書きできる (不正な値は既定値に戻して warn)。
 * - 応答 (JSON): { status: 'maintenance' } / { status: 'not_configured' } / { status: 'idle' | 'processed', ...summary }
 *   (件数だけ。利用者 ID・RevenueCat の生の文は出さない)。取り直せなかった利用者がいる回 (IapReconcileFailedError)・候補の RPC と印の RPC の失敗は
 *   500 (本文は汎用。要約と詳細は app_logs)。
 * - AI を使わない (AI の SDK・Edge Function を import しない。tests/ai-usage-contract.test.ts の CRON_ENTRYPOINTS)。
 */
import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { internalError } from '@/lib/api/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { isMaintenanceFlagOn } from '@/lib/maintenance-mode';
import { RevenueCatNotConfiguredError, type RevenueCatGateway } from '@/lib/billing/iap-core';
import { createRevenueCatGateway } from '@/lib/billing/revenuecat-gateway';
import { createIapRepository } from '@/lib/billing/iap-repository';
import { createIapReconcileRepository } from '@/lib/billing/iap-reconcile-repository';
import { reconcileStoreSubscriptions } from '@/lib/billing/iap-reconcile-service';
import { IapReconcileFailedError, resolveIapReconcileSettings } from '@/lib/billing/iap-reconcile-core';

// fetch (RevenueCat) と supabase-js を使うので Node.js ランタイムで動かす
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// supabase-js の RPC (POST) と RevenueCat への fetch を、同じ内容でも毎回送る (app-log-alerts の route と同じ理由で明示する)
export const fetchCache = 'force-no-store';
// 根拠は IAP_RECONCILE_MAX_DURATION_SECONDS (src/lib/billing/iap-reconcile-core.ts)。route segment config はリテラルだけ (一致はテスト 28)
export const maxDuration = 60;

/** 構造化ログ (app_logs.function_name) の名前。cron/push-outbox と同じ付け方 (失敗の監視の候補の LIKE 'cron/%' に当たる) */
const ROUTE_NAME = 'cron/iap-reconcile';

export async function GET(req: Request) {
  // 1. 認証 (401 / 503)
  const authError = await requireCronAuth(req);
  if (authError) return authError;
  const requestId = generateRequestId();
  const logger = createLogger(ROUTE_NAME, requestId);
  // 2. メンテナンス中は何もせず次の回へ (operator/11 の R-14 と同じ)
  if (await isMaintenanceFlagOn()) {
    return NextResponse.json({ status: 'maintenance' });
  }
  // 3. 鍵が無ければ何もしない (DB にも触れない。変数名は warn にだけ書く)
  let gateway: RevenueCatGateway;
  try {
    gateway = createRevenueCatGateway();
  } catch (error) {
    if (error instanceof RevenueCatNotConfiguredError) {
      logger.warn('REVENUECAT_SECRET_API_KEY が未設定のため、ストアの購読の取り直しを行いません');
      return NextResponse.json({ status: 'not_configured' });
    }
    return internalError(ROUTE_NAME, error, { requestId });
  }
  // 4. 環境変数の値の解釈 (不正な値は既定に戻して warn。値そのものは書かない)
  const settings = resolveIapReconcileSettings({
    batchSize: process.env.IAP_RECONCILE_BATCH_SIZE,
    recheckHours: process.env.IAP_RECONCILE_RECHECK_HOURS,
  });
  if (settings.ignored.length > 0) {
    logger.warn('ストアの購読の取り直しの環境変数の値が正しくないため、既定値を使います', { ignored_env: settings.ignored });
  }
  // 5. 候補を選ぶ → 1 人ずつ取り直す
  try {
    const summary = await reconcileStoreSubscriptions(
      { gateway, repository: createIapRepository(), reconcileRepository: createIapReconcileRepository() },
      settings,
    );
    if (summary.candidates > 0) {
      logger.info('ストアの購読の取り直しを処理しました', { ...summary });
    }
    // ログの保存 (回の要約。待たずに進む) は、createLogger が 1 行ごとに保存が終わるまで関数を止めさせない (#1909)。route では延命しない
    return NextResponse.json({ status: summary.candidates === 0 ? 'idle' : 'processed', ...summary });
  } catch (err) {
    // 6. 取り直せなかった利用者がいる回・候補の RPC と印の RPC の失敗・想定外は 500 (本文は汎用。app_logs の error → app-log-alerts の cron_failure)。
    //    取り直せなかった回は要約 (件数と種類だけ) を error の metadata に残す
    if (err instanceof IapReconcileFailedError) {
      return internalError(ROUTE_NAME, err, { requestId, summary: err.summary });
    }
    return internalError(ROUTE_NAME, err, { requestId });
  }
}

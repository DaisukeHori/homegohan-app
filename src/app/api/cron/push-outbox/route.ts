/**
 * GET /api/cron/push-outbox — Push 通知の送信待ち (push_outbox) を Expo に送る worker (Vercel Cron。毎分。#1136)
 *
 * 1 回の実行: 送信待ちを取る → 送る条件を確かめて Expo に送る → 15 分たった送信済みの receipt を確かめる → 掃除。
 * 本体は src/lib/push/outbox.ts の processPushOutbox (純粋)、DB は src/lib/push/outbox-store.ts、Expo は src/lib/push/expo-transport.ts、
 * 文面は src/lib/push/render.ts。設計は docs/design/mobile/06-push-send.md §6.6。
 *
 * - 認証: Vercel Cron が付ける `Authorization: Bearer <CRON_SECRET>` (src/lib/cron-auth.ts の requireCronAuth)。
 * - メンテナンス中は何もせず次の回に回す (掃除もしない)。
 * - EXPO_ACCESS_TOKEN が未設定なら送らず、掃除だけをする (24 時間を超えた送信待ちを expired にし、送信済み・届けられなかった行を期限で消す)。
 *   変数名は warn のログにだけ書き、応答には出さない。
 * - PUSH_OUTBOX_MAX_ATTEMPTS / PUSH_OUTBOX_BATCH_SIZE で試行の上限と 1 回の件数を上書きできる (不正な値は既定値に戻して warn)。
 * - 応答 (JSON): { status: 'maintenance' } / { status: 'not_configured', cleaned_expired, cleaned_sent, cleaned_dead } /
 *   { status: 'idle' | 'processed', ...summary } (件数だけ。文面・token・利用者 ID は出さない)。
 *   RPC の失敗・応答の形の誤りは 500 (本文は汎用。詳細は app_logs)。
 */
import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { PUSH_NOTIFICATION_KIND_SPECS } from '@homegohan/shared';
import { requireCronAuth } from '@/lib/cron-auth';
import { internalError } from '@/lib/api/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { isMaintenanceFlagOn } from '@/lib/maintenance-mode';
import { isLegalConsentEnforced } from '@/lib/legal-consent';
import { processPushOutbox, resolvePushOutboxSettings } from '@/lib/push/outbox';
import { createOutboxStore } from '@/lib/push/outbox-store';
import { createExpoTransport } from '@/lib/push/expo-transport';
import { renderPushMessage } from '@/lib/push/render';

// fetch (Expo) と node:crypto (randomUUID) を使うので Node.js ランタイムで動かす
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// supabase-js の RPC (POST) と Expo への fetch を、同じ内容でも毎回送る (app-log-alerts の route と同じ理由で明示する)
export const fetchCache = 'force-no-store';
export const maxDuration = 60; // Vercel Pro: 60s。送信は PUSH_OUTBOX_RUN_BUDGET_MS (40 秒) で打ち切る

/** 構造化ログ (app_logs.function_name) の名前。cron/app-log-alerts と同じ付け方 */
const ROUTE_NAME = 'cron/push-outbox';

export async function GET(req: Request) {
  // 1. 認証 (401 / 503)
  const authError = await requireCronAuth(req);
  if (authError) return authError;
  const requestId = generateRequestId();
  const logger = createLogger(ROUTE_NAME, requestId);
  // 2. メンテナンス中は何もせず次の回へ (R-14)
  if (await isMaintenanceFlagOn()) {
    return NextResponse.json({ status: 'maintenance' });
  }
  try {
    const store = createOutboxStore();
    // 3. 鍵が無ければ送らず、掃除だけ (R-12。変数名は warn にだけ書く)
    const accessToken = process.env.EXPO_ACCESS_TOKEN;
    if (!accessToken) {
      const cleaned = await store.cleanup();
      logger.warn('EXPO_ACCESS_TOKEN が未設定のため、Push 通知を送りません (掃除だけをしました)', { ...cleaned });
      return NextResponse.json({
        status: 'not_configured',
        cleaned_expired: cleaned.expired,
        cleaned_sent: cleaned.sent,
        cleaned_dead: cleaned.dead,
      });
    }
    const settings = resolvePushOutboxSettings({
      maxAttempts: process.env.PUSH_OUTBOX_MAX_ATTEMPTS,
      batchSize: process.env.PUSH_OUTBOX_BATCH_SIZE,
    });
    if (settings.ignored.length > 0) {
      logger.warn('Push の送信待ちの環境変数の値が正しくないため、既定値を使います', { ignored_env: settings.ignored });
    }
    // 4. 送る → receipt → 掃除
    const summary = await processPushOutbox(
      {
        store,
        transport: createExpoTransport(accessToken),
        kinds: PUSH_NOTIFICATION_KIND_SPECS,
        render: renderPushMessage,
        now: Date.now,
        log: logger,
      },
      {
        workerId: randomUUID(),
        maxAttempts: settings.maxAttempts,
        batchSize: settings.batchSize,
        legalConsentEnforced: isLegalConsentEnforced(),
      },
    );
    if (summary.claimed > 0 || summary.receipts_claimed > 0 || summary.cleaned_expired > 0) {
      logger.info('Push の送信待ちを処理しました', { ...summary });
    }
    // ログの保存 (回の要約・dead の理由。待たずに進む) は、createLogger が 1 行ごとに保存が終わるまで関数を止めさせない (#1909)。
    // route では延命しない
    return NextResponse.json({
      status: summary.claimed === 0 && summary.receipts_claimed === 0 ? 'idle' : 'processed',
      ...summary,
    });
  } catch (err) {
    // 5. RPC の失敗・応答の形の誤りは 500 (本文は汎用)
    return internalError(ROUTE_NAME, err, { requestId });
  }
}

/**
 * GET /api/cron/login-alerts — 新しい端末・地域からのログインを本人にメールで知らせる worker (Vercel Cron。毎分。#1190)
 *
 * 設計の正典 docs/design/cross/16-auth-history-sessions.md §14.8・§13.3・§13.4。
 * 本体は src/lib/auth/sessions/login-alert-worker.ts の processLoginAlerts (取り置き → 判定 → 送信待ちへの登録 → 記録)。
 * route は sendEmail も store も直接は呼ばない。
 *
 * - 認証: Vercel Cron が付ける `Authorization: Bearer <CRON_SECRET>` (src/lib/cron-auth.ts の requireCronAuth)。
 * - 環境変数 AUTH_LOGIN_ALERT (on / off。未設定は on): off なら判定して印を付けるが、メールを送らない。
 *   値を読むのはこのファイルだけ (src/lib/env.ts の readOnlyBy)。解釈は src/lib/auth/sessions/constants.ts の resolveLoginAlertMode。
 *   不正な値は on に戻し、warn のログに変数名だけを残す (値は出さない)。
 * - 応答 (JSON): { claimed, queued, skipped, failed } (件数だけ。queued = 通知メールを送信待ち email_outbox に登録し、記録まで済んだ行の数。
 *   届いたかは email_outbox の行が持つ)。取り置き (RPC) の失敗は 500 (本文は汎用。詳細は app_logs)。
 */
import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { internalError } from '@/lib/api/errors';
import { AUTH_LOGIN_ALERT_ENV_NAME, resolveLoginAlertMode } from '@/lib/auth/sessions/constants';
import { createLoginAlertWorkerDeps, processLoginAlerts } from '@/lib/auth/sessions/login-alert-worker';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { getSupabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// supabase-js の RPC (POST) を、同じ内容でも毎回送る (push-outbox・app-log-alerts の route と同じ理由で明示する)
export const fetchCache = 'force-no-store';

/** 構造化ログ (app_logs.function_name) の名前。cron/push-outbox と同じ付け方 */
const ROUTE_NAME = 'cron/login-alerts';

export async function GET(req: Request) {
  const authError = await requireCronAuth(req);
  if (authError) return authError;
  const requestId = generateRequestId();
  const setting = resolveLoginAlertMode(process.env.AUTH_LOGIN_ALERT);
  if (setting.ignored) {
    // 値は出さない (変数名だけ)
    createLogger(ROUTE_NAME, requestId).warn('不審なログインの通知のスイッチの値が正しくないため、on として扱います', {
      ignored_env: AUTH_LOGIN_ALERT_ENV_NAME,
    });
  }
  try {
    const summary = await processLoginAlerts(createLoginAlertWorkerDeps(getSupabaseAdmin()), { alertMode: setting.mode });
    return NextResponse.json({
      claimed: summary.claimed,
      queued: summary.queued,
      skipped: summary.skipped,
      failed: summary.failed,
    });
  } catch (err) {
    return internalError(ROUTE_NAME, err, { requestId });
  }
}

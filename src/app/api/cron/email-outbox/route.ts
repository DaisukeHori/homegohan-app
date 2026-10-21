/**
 * GET /api/cron/email-outbox — メールの送信待ち (email_outbox) を送る worker (Vercel Cron。毎分。#1193)
 *
 * sendEmail (src/lib/emails/send.ts) は Resend を呼ばず、email_outbox に 1 行入れるだけ。送るのはこの route だけ
 * (docs/design/operator/10-logs-and-mail-retry.md §6.5)。
 *
 * - 認証: Vercel Cron が付ける `Authorization: Bearer <CRON_SECRET>` (src/lib/cron-auth.ts の requireCronAuth)。
 * - RESEND_API_KEY が未設定なら行を取らない (queued は残り、鍵が入った回で送る)。
 * - 1 回の実行で最大 EMAIL_OUTBOX_BATCH_SIZE 行 (既定 20) を取り (claim_email_outbox。リース 120 秒・SKIP LOCKED)、
 *   期限 (7 日) → 宛先停止リスト → Resend 1 回 → complete_email_outbox / fail_email_outbox の順で処理する。
 *   再試行するか dead にするかは DB の fail_email_outbox が決める (試行の上限は EMAIL_OUTBOX_MAX_ATTEMPTS。既定 6 回)。
 *   本体は src/lib/emails/outbox.ts の processEmailOutbox、DB の読み書きは src/lib/emails/outbox-store.ts。
 * - 環境変数 EMAIL_OUTBOX_MAX_ATTEMPTS / EMAIL_OUTBOX_BATCH_SIZE の値を読むのはこのファイルだけ。不正な値は既定に戻し、変数名だけを warn に残す。
 * - 応答にもログにも宛先・件名・本文は入れない (件数と、マスクした宛先・文面の名前だけ)。
 *
 * 応答 (JSON): { status: 'not_configured' | 'idle' | 'processed', claimed, sent, requeued, dead, dead_codes, stopped_early }
 *   (not_configured のときは status だけ)。claim / complete / fail の RPC の失敗・応答の形の誤りは 500 (本文は汎用。原因は app_logs)。
 */
import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { internalError } from '@/lib/api/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { lookupEmailSuppression } from '@/lib/emails/suppression';
import { createResendTransport, processEmailOutbox, resolveEmailOutboxSettings } from '@/lib/emails/outbox';
import { createOutboxStore } from '@/lib/emails/outbox-store';

// Resend の SDK と node:crypto は Node.js ランタイムで動く。Edge にはしない
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// supabase-js の RPC (POST) と Resend の呼び出しを、前回の応答で返させない (app-log-alerts/route.ts と同じ理由)
export const fetchCache = 'force-no-store';
// Vercel Pro: 60s。送る時間は EMAIL_OUTBOX_RUN_BUDGET_MS (40 秒) で打ち切り、残りはリース (120 秒) が切れたあとの回に回す
export const maxDuration = 60;

const ROUTE_NAME = 'cron/email-outbox';

export async function GET(req: Request) {
  // 1. 認証 (401 / 503)。tests/cron-secret-contract.test.ts の規則 4
  const authError = await requireCronAuth(req);
  if (authError) return authError;
  const requestId = generateRequestId();
  const logger = createLogger(ROUTE_NAME, requestId);
  // 2. 鍵が無ければ取らない (queued は残り、鍵が入った回で送る)
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn('RESEND_API_KEY が未設定のため、送信待ちのメールを送りません');
    return NextResponse.json({ status: 'not_configured' });
  }
  const settings = resolveEmailOutboxSettings({
    maxAttempts: process.env.EMAIL_OUTBOX_MAX_ATTEMPTS,
    batchSize: process.env.EMAIL_OUTBOX_BATCH_SIZE,
  });
  if (settings.ignored.length > 0) {
    logger.warn('送信待ちの環境変数の値が正しくないため、既定値を使います', { ignored_env: settings.ignored });
  }
  try {
    const summary = await processEmailOutbox(
      {
        store: createOutboxStore(),
        transport: createResendTransport(apiKey),
        suppression: lookupEmailSuppression,
        now: Date.now,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        log: logger,
      },
      { workerId: randomUUID(), maxAttempts: settings.maxAttempts, batchSize: settings.batchSize },
    );
    if (summary.claimed > 0) logger.info('送信待ちのメールを処理しました', { ...summary });
    // ログの保存 (待たずに進む) は、createLogger が 1 行ごとに保存が終わるまで関数を止めさせない (#1909)。route では延命しない
    return NextResponse.json({ status: summary.claimed === 0 ? 'idle' : 'processed', ...summary });
  } catch (err) {
    return internalError(ROUTE_NAME, err, { requestId }); // 3. claim / complete / fail の RPC の失敗・応答の形の誤りは 500 (本文は汎用)
  }
}

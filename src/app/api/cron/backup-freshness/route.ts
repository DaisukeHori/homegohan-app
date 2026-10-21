/**
 * GET /api/cron/backup-freshness — DB バックアップが新しく取れていないことを運用メールに知らせる (Vercel Cron。日 1 回 14:37 JST。#1129)
 *
 * 設計: docs/design/cross/17-backup-automation.md §7.3 (状態遷移は §8.3 の「鮮度」の行・応答は §11)。
 * GitHub Actions の db-backup (毎日 02:23 JST) が admin_audit_logs に残す取得の行 (backup.daily.completed) の最新 1 行を読み、
 * BACKUP_STALE_AFTER_HOURS (30 時間) より古い・1 行も無いときに、環境変数 OPS_ALERT_EMAIL のアドレスへ 1 通知らせる。
 * 取得が失敗したときは Actions が Issue を立てるが、定期実行そのものが止まった (60 日 push の無いリポジトリの schedule を
 * GitHub が止める・secrets の誤りで監査行が書けない) ときは何も失敗しないので、ここで「走っていない」ことに気づく (R-8)。
 *
 * - 認証: Vercel Cron が付ける `Authorization: Bearer <CRON_SECRET>` (src/lib/cron-auth.ts の requireCronAuth)。
 * - 宛先: src/lib/ops-alerts/recipient.ts の resolveOpsAlertRecipient (app-log-alerts と共有)。
 *   未設定なら info ログ 1 行で disabled、形が違えば warn ログ 1 行で invalid_config。どちらも DB に触れない。
 * - 読む行: action_type が backup.daily.completed かつ target_type が database_backup かつ actor_id が NULL
 *   (record_backup_audit が書く形)。運営のロールの人が自分の JWT で書いた行 (actor_id = 本人) では fresh にしない (S-23)。
 * - 送る権利: claim_ops_alert('backup_stale', 1380 分)。cron の間隔 (1440 分) より短いので翌日の回は取れ、
 *   同じ日の 2 回目 (Vercel Cron の二重起動・手動の再実行) は止まる。
 *   送らなかった / 送れなかったときは release_ops_alert で権利を返す (設定が直ったあともクールダウンで黙らないように)。
 *   ただし宛先が停止リストに載っている (suppressed)・文面の不備 (invalid_envelope) のときは返さない
 *   (送り直しても同じ結果で、回ごとの繰り返しになるため。app-log-alerts と同じ規則。#1577 の 8。
 *   NON_RELEASING_SEND_ERROR_CODES は src/lib/ops-alerts/send-release.ts で共有する)。
 *   返す操作の失敗は warn ログ 1 行だけで、応答は変えない。
 * - メールにも、ログにも、応答にも、宛先・利用者の情報は入れない。載せるのは最新の取得の日時としきい値だけ。
 * - AI を使わない (AI の SDK・Edge Function を import しない。tests/ai-usage-contract.test.ts の CRON_ENTRYPOINTS)。
 *
 * 応答 (JSON): { status, latest_completed_at?, stale_after_hours? }
 *   status: disabled / invalid_config / fresh / stale_deduped / stale_sent / stale_send_skipped / stale_send_failed
 *   DB の失敗 (読む・権利を取る) と、権利を取ったあとの例外は 500。本文は汎用メッセージだけで、詳細は app_logs に残す。
 */
import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { internalError } from '@/lib/api/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/emails/send';
import type { SendEmailResult } from '@/lib/emails/send-result';
import { renderBackupStaleEmail } from '@/lib/emails/ops/backup-stale';
import { resolveOpsAlertRecipient } from '@/lib/ops-alerts/recipient';
import { NON_RELEASING_SEND_ERROR_CODES } from '@/lib/ops-alerts/send-release';
import {
  BACKUP_AUDIT_TARGET_TYPE,
  BACKUP_STALE_AFTER_HOURS,
  BACKUP_STALE_ALERT_COOLDOWN_MINUTES,
  BACKUP_STALE_ALERT_KEY,
  backupAuditAction,
  isBackupStale,
} from '@/lib/backups/core';

// sendEmail (Resend の SDK と node:crypto) は Node.js ランタイムで動く。Edge にはしない
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// supabase-js の select / RPC が「同じ内容なら前回の応答」で返らないよう、この route の fetch はすべてキャッシュしない
// (app-log-alerts と同じ理由。最新の取得の日時も、送る権利も、毎回 DB から読む)
export const fetchCache = 'force-no-store';
export const maxDuration = 60; // Vercel Pro: 60s OK (読むのは 1 行・メールは送信待ちに登録するだけ)

/** 構造化ログ (app_logs.function_name) の名前。cron/app-log-alerts と同じ付け方 */
const ROUTE_NAME = 'cron/backup-freshness';

/** 取得の行のうち、鮮度に使う action_type (日次の成功) */
const DAILY_COMPLETED_ACTION = backupAuditAction('daily', 'completed');

type AdminClient = ReturnType<typeof getSupabaseAdmin>;
type Logger = ReturnType<typeof createLogger>;

type StaleStatus = 'stale_deduped' | 'stale_sent' | 'stale_send_skipped' | 'stale_send_failed';

/** 最新の行の created_at。行が無い・形が違うときは null (isBackupStale が「古い」とみなす) */
function latestCompletedAtOf(row: unknown): string | null {
  if (typeof row !== 'object' || row === null || !('created_at' in row)) return null;
  const value = row.created_at;
  return typeof value === 'string' && value ? value : null;
}

/**
 * 取った「送る権利」を返す。失敗しても例外にしない (すでに「送れなかった」という本題を抱えているため)。
 * 返せなくても、クールダウン (1380 分) は cron の間隔 (1440 分) より短いので翌日の回は取れる (§8.3)
 */
async function releaseClaim(supabase: AdminClient, claimedAt: string, logger: Logger): Promise<void> {
  const message = '送る権利を返せませんでした。次の通知はクールダウンの後になります (翌日の確認には間に合います)';
  try {
    const { error } = await supabase.rpc('release_ops_alert', {
      p_alert_key: BACKUP_STALE_ALERT_KEY,
      p_claimed_at: claimedAt,
    });
    if (error) {
      logger.warn(message, { pg_code: error.code });
    }
  } catch (err) {
    logger.warn(message, { error_name: err instanceof Error ? err.name : typeof err });
  }
}

/** 認証のあとの本体: 宛先 → 最新の取得の行を読む → 古ければ権利を取る → メールを送る */
async function checkBackupFreshness(): Promise<NextResponse> {
  const requestId = generateRequestId();
  const logger = createLogger(ROUTE_NAME, requestId);

  // 宛先。未設定なら何もしない (本番は、オーナーが決めて設定するまで未設定)。値そのもの (メールアドレス) はログに出さない
  const recipient = resolveOpsAlertRecipient();
  if (recipient.status === 'disabled') {
    logger.info('OPS_ALERT_EMAIL が未設定のため、DB バックアップの鮮度の通知は行いません');
    return NextResponse.json({ status: 'disabled' });
  }
  if (recipient.status === 'invalid_config') {
    logger.warn('OPS_ALERT_EMAIL がメールアドレス (1 つ) の形ではないため、DB バックアップの鮮度の通知は行いません');
    return NextResponse.json({ status: 'invalid_config' });
  }

  try {
    const supabase = getSupabaseAdmin();

    // 1. 取得の行 (actor_id NULL・target_type database_backup) の最新 1 行。select は文字列リテラル (select-columns-exist の走査)
    const latest = await supabase
      .from('admin_audit_logs')
      .select('created_at')
      .eq('action_type', DAILY_COMPLETED_ACTION)
      .eq('target_type', BACKUP_AUDIT_TARGET_TYPE)
      .is('actor_id', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest.error) {
      return internalError(ROUTE_NAME, latest.error, { requestId, stage: 'read_latest' });
    }
    const latestCompletedAt = latestCompletedAtOf(latest.data);
    const freshness = { latest_completed_at: latestCompletedAt, stale_after_hours: BACKUP_STALE_AFTER_HOURS };

    if (!isBackupStale(latestCompletedAt, new Date())) {
      return NextResponse.json({ status: 'fresh', ...freshness });
    }

    // 2. 送る権利を取る。前回の送信から 1380 分たっていなければ NULL で、送らない
    const claimed = await supabase.rpc('claim_ops_alert', {
      p_alert_key: BACKUP_STALE_ALERT_KEY,
      p_cooldown_minutes: BACKUP_STALE_ALERT_COOLDOWN_MINUTES,
    });
    if (claimed.error) {
      return internalError(ROUTE_NAME, claimed.error, { requestId, rpc: 'claim_ops_alert' });
    }
    const claimedAt = typeof claimed.data === 'string' && claimed.data ? claimed.data : null;
    if (!claimedAt) {
      return respondStale('stale_deduped', freshness, logger);
    }

    // 3. メールを作って送る。権利を取ったあとの例外 (文面を作る・送る) はここで受け、必ず権利を返してから扱う
    let sent: { readonly result: SendEmailResult } | { readonly thrown: unknown };
    try {
      const envelope = renderBackupStaleEmail({
        to_email: recipient.email,
        latest_completed_at: latestCompletedAt,
        stale_after_hours: BACKUP_STALE_AFTER_HOURS,
      });
      sent = { result: await sendEmail(envelope) };
    } catch (thrown) {
      sent = { thrown };
    }

    if ('thrown' in sent) {
      await releaseClaim(supabase, claimedAt, logger);
      return internalError(ROUTE_NAME, sent.thrown, { requestId, stage: 'send_email', ...freshness });
    }

    const { result } = sent;
    if (result.ok) {
      return respondStale('stale_sent', freshness, logger, { outbox_id: result.id });
    }
    // 送れなかった、または送らなかった。宛先停止・文面の不備は送り直しても同じなので、権利を返さない (抑止が効く。#1577 の 8)。
    // それ以外 (送信の設定が未完了・送信待ちへの登録の失敗など) は権利を返して、設定が直ったあとの回で送れるようにする。
    // 失敗そのものの記録 (宛先をマスクした error) は sendEmail が済ませている
    if (!NON_RELEASING_SEND_ERROR_CODES.has(result.error.code)) {
      await releaseClaim(supabase, claimedAt, logger);
    }
    return respondStale(result.skipped ? 'stale_send_skipped' : 'stale_send_failed', freshness, logger, {
      error_code: result.error.code,
    });
  } catch (err) {
    return internalError(ROUTE_NAME, err, { requestId });
  }
}

/** 古いときの応答。どの結果でも warn ログを 1 行残す (最新の取得の日時としきい値だけ。宛先は書かない) */
function respondStale(
  status: StaleStatus,
  freshness: { readonly latest_completed_at: string | null; readonly stale_after_hours: number },
  logger: Logger,
  extra: Readonly<Record<string, unknown>> = {},
): NextResponse {
  logger.warn(`DB バックアップが ${freshness.stale_after_hours} 時間以上新しく取れていません`, {
    status,
    ...freshness,
    ...extra,
  });
  return NextResponse.json({ status, ...freshness });
}

export async function GET(req: Request) {
  // CRON 認証 (Vercel Cron の Authorization header をチェック。定数時間の比較と旧シークレットの受け付けは共通ヘルパー)
  const authError = await requireCronAuth(req);
  if (authError) return authError;

  // ログの保存 (待たずに進む) は、createLogger が 1 行ごとに保存が終わるまで関数を止めさせない (#1909)。route では延命しない
  return checkBackupFreshness();
}

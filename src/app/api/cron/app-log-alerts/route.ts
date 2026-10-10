/**
 * GET /api/cron/app-log-alerts — 本番エラーの急増を運用メールに知らせる (Vercel Cron。15 分おき。#1157)
 *
 * app_logs の level='error' を、直近 15 分ぶん function_name ごとに数える。合計がしきい値 (既定 20 件) を超えていたら、
 * 環境変数 OPS_ALERT_EMAIL のアドレスに 1 通だけメールを送る。しきい値などの定数と、メールに載せる内容の決め方は
 * src/lib/ops-alerts/app-log-error-spike.ts、文面は src/lib/emails/ops/app-log-error-spike.ts。
 *
 * - 認証: Vercel Cron が付ける `Authorization: Bearer <CRON_SECRET>` (src/lib/cron-auth.ts の requireCronAuth。
 *   定数時間の比較と、入れ替え中の旧シークレット CRON_SECRET_PREVIOUS の受け付けは共通ヘルパーが行う)。
 * - OPS_ALERT_EMAIL が未設定なら、何もしない (info ログを 1 行残すだけ。DB にも触れない)。
 *   形がメールアドレスでないときも、送らずに warn ログを残す。
 * - しきい値とクールダウンは、環境変数 OPS_ALERT_ERROR_THRESHOLD / OPS_ALERT_COOLDOWN_MINUTES で上書きできる
 *   (どちらも任意。不正な値は既定値に戻し、どの変数を無視したかを warn で残す)。窓 (15 分) は vercel.json の間隔と結びつくので変えない。
 * - 同じアラートはクールダウン (既定 60 分) の間は送り直さない。「送ってよいか」は DB の claim_ops_alert が原子的に決める
 *   (Vercel Cron はまれに同じ回を 2 回呼ぶ。読んでから書く作りだと 2 通届く)。
 *   メールを送れなかったとき (送信の設定が未完了・Resend が断った・例外) は、release_ops_alert で権利を返す。
 *   送れていないのに「送った」と記録したままだと、設定が直ったあともクールダウンの間は通知が来ないため。
 *   権利を取ったあとで関数ごと止められた (時間切れ・デプロイの切り替えなど) ときだけは返せず、次の通知が最大でクールダウンの分だけ遅れる (まれ)。
 * - メールが届くことには依存しない。本番はまだ送信ドメインが未検証で、メールは届かない。送れなかったときは
 *   sendEmail が app_logs に記録し (error)、この route も件数と関数名を warn で残す。応答は 200 のままにする
 *   (数える処理自体は正常に動いている。送れなかったかどうかは応答の status で分かる)。
 * - infra_alerts は書かない (インフラ画面は「未接続」のまま: #1180)。
 * - メールにも、ログにも、応答にも、ユーザー ID・メールアドレス・ログの本文は入れない。載せるのは件数と関数名だけ。
 *
 * 応答 (JSON): { status, total?, threshold?, window_minutes? }
 *   status: disabled / invalid_config / below_threshold / deduped / sent / send_skipped / send_failed
 *   DB の失敗 (数える・権利を取る) は 500。本文は汎用メッセージだけで、詳細は app_logs に残す (#1172)。
 */
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { requireCronAuth } from '@/lib/cron-auth';
import { internalError } from '@/lib/api/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/emails/send';
import type { SendEmailResult } from '@/lib/emails/send-result';
import { EmailEnvelopeSchema } from '@/lib/emails/envelope';
import { renderAppLogErrorSpikeEmail } from '@/lib/emails/ops/app-log-error-spike';
import { getSiteUrl } from '@/lib/site-config';
import {
  APP_LOG_ALERT_KEY,
  APP_LOG_ALERT_MAX_FUNCTIONS,
  APP_LOG_ALERT_WINDOW_MINUTES,
  SUPER_ADMIN_LOGS_PATH,
  exceedsErrorThreshold,
  parseErrorCountRows,
  resolveAppLogAlertSettings,
  summarizeErrorCounts,
} from '@/lib/ops-alerts/app-log-error-spike';

// sendEmail (Resend の SDK と node:crypto) は Node.js ランタイムで動く。Edge にはしない
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Next 14 の route handler では、dynamic = 'force-dynamic' だけでは fetch のキャッシュ (Data Cache) は切れない
// (force-dynamic だとリクエストの読み取りも追跡されず、ほかの route が cookies() などで暗黙に得ている「キャッシュしない」も効かない)。
// すると、supabase-js の RPC (POST) や Resend の呼び出しが「同じ内容なら前回の応答」で返ってしまい、
// 数えた件数も、送る権利 (claim_ops_alert) も、毎回同じ古い値になる。ローカルの動作確認で、DB を書き換えても応答が変わらなかった。
// この route の fetch は、すべてキャッシュしない。
export const fetchCache = 'force-no-store';
export const maxDuration = 60; // Vercel Pro: 60s OK (メールの再試行を含めても数秒で終わる)

/** 構造化ログ (app_logs.function_name) の名前。cron/process-menu-queue と同じ付け方 */
const ROUTE_NAME = 'cron/app-log-alerts';

/**
 * 応答を返したあとも関数を延命する時間 (ミリ秒)。
 * createLogger の書き込みは待たずに進む (非同期)。応答を返した直後に関数が止められると、書き込み中のログが失われることがある。
 * この route の最後のログ (送れなかったときの件数と関数名) は、メールが届かない間の唯一の手がかりなので、少しだけ延命して書き切らせる。
 */
const LOG_FLUSH_GRACE_MS = 1000;

type AdminClient = ReturnType<typeof getSupabaseAdmin>;
type Logger = ReturnType<typeof createLogger>;

/**
 * 取った「送る権利」を返す。失敗しても例外にしない (すでに「送れなかった」という本題を抱えているため)。
 * 返せなかったときは、次の通知が最大でクールダウン (cooldownMinutes) 分遅れるだけ。
 */
async function releaseClaim(
  supabase: AdminClient,
  claimedAt: string,
  cooldownMinutes: number,
  logger: Logger,
): Promise<void> {
  const message = `送る権利を返せませんでした。次の通知が最大 ${cooldownMinutes} 分遅れることがあります`;
  try {
    const { error } = await supabase.rpc('release_ops_alert', {
      p_alert_key: APP_LOG_ALERT_KEY,
      p_claimed_at: claimedAt,
    });
    if (error) {
      logger.warn(message, { pg_code: error.code });
    }
  } catch (err) {
    logger.warn(message, {
      error_name: err instanceof Error ? err.name : typeof err,
    });
  }
}

/** 認証のあとの本体: 数える → しきい値 → 送る権利を取る → メールを送る */
async function checkAppLogErrors(): Promise<NextResponse> {
  const requestId = generateRequestId();
  const logger = createLogger(ROUTE_NAME, requestId);

  // 宛先。未設定なら何もしない (本番は、オーナーが決めて設定するまで未設定)。
  // 値そのもの (メールアドレス) はログに出さない
  const configured = process.env.OPS_ALERT_EMAIL?.trim();
  if (!configured) {
    logger.info('OPS_ALERT_EMAIL が未設定のため、エラー急増の通知は行いません');
    return NextResponse.json({ status: 'disabled' });
  }
  const recipient = EmailEnvelopeSchema.shape.to.safeParse(configured);
  if (!recipient.success) {
    logger.warn('OPS_ALERT_EMAIL がメールアドレス (1 つ) の形ではないため、エラー急増の通知は行いません');
    return NextResponse.json({ status: 'invalid_config' });
  }

  // しきい値とクールダウン。運用で変えるときは環境変数で上書きする (未設定なら既定の 20 件・60 分)。
  // 値が不正なら既定値に戻して進め (通知は止めない)、どの変数を無視したかだけを warn で残す (値は出さない)
  const settings = resolveAppLogAlertSettings({
    errorThreshold: process.env.OPS_ALERT_ERROR_THRESHOLD,
    cooldownMinutes: process.env.OPS_ALERT_COOLDOWN_MINUTES,
  });
  if (settings.ignored.length > 0) {
    logger.warn('しきい値・クールダウンの環境変数の値が正しくないため、既定値を使います', {
      ignored_env: settings.ignored,
    });
  }

  try {
    const supabase = getSupabaseAdmin();

    // 1. 直近の窓の error を function_name ごとに数える (関数名と件数だけを返す DB の関数。本文・ユーザー ID は読まない)
    const counted = await supabase.rpc('app_log_error_counts', {
      p_window_minutes: APP_LOG_ALERT_WINDOW_MINUTES,
      p_limit: APP_LOG_ALERT_MAX_FUNCTIONS,
    });
    if (counted.error) {
      return internalError(ROUTE_NAME, counted.error, { requestId, rpc: 'app_log_error_counts' });
    }
    const summary = summarizeErrorCounts(parseErrorCountRows(counted.data));
    const counts = {
      total: summary.total,
      threshold: settings.errorThreshold,
      window_minutes: APP_LOG_ALERT_WINDOW_MINUTES,
    };

    if (!exceedsErrorThreshold(summary.total, settings.errorThreshold)) {
      return NextResponse.json({ status: 'below_threshold', ...counts });
    }

    // 2. 送る権利を取る。クールダウン中 (直近 cooldownMinutes 分に送った。既定 60 分) なら NULL で、送らない
    const claimed = await supabase.rpc('claim_ops_alert', {
      p_alert_key: APP_LOG_ALERT_KEY,
      p_cooldown_minutes: settings.cooldownMinutes,
    });
    if (claimed.error) {
      return internalError(ROUTE_NAME, claimed.error, { requestId, rpc: 'claim_ops_alert' });
    }
    const claimedAt = typeof claimed.data === 'string' && claimed.data ? claimed.data : null;
    if (!claimedAt) {
      return NextResponse.json({ status: 'deduped', ...counts });
    }

    // 3. メールを作って送る。件数と関数名だけを載せる。
    // 権利を取ったあとの例外 (文面を作る・送る) はここで受け、必ず権利を返してから扱う
    // (sendEmail は配信の失敗で例外を投げない作りだが、想定外の例外でもクールダウンの沈黙を残さない)
    let sent: { readonly result: SendEmailResult } | { readonly thrown: unknown };
    try {
      const envelope = renderAppLogErrorSpikeEmail({
        to_email: recipient.data,
        total: summary.total,
        window_minutes: APP_LOG_ALERT_WINDOW_MINUTES,
        threshold: settings.errorThreshold,
        cooldown_minutes: settings.cooldownMinutes,
        functions: summary.functions,
        other_count: summary.otherCount,
        logs_url: `${getSiteUrl()}${SUPER_ADMIN_LOGS_PATH}`,
        detected_at: new Date(),
      });
      sent = { result: await sendEmail(envelope) };
    } catch (thrown) {
      sent = { thrown };
    }

    // ログには、通知の中身 (件数と関数名) だけを残す。メールが届かなくても、ここから何が起きていたか分かる
    const alertMeta = {
      ...counts,
      other_count: summary.otherCount,
      functions: summary.functions,
    };

    if ('thrown' in sent) {
      await releaseClaim(supabase, claimedAt, settings.cooldownMinutes, logger);
      return internalError(ROUTE_NAME, sent.thrown, { requestId, stage: 'send_email', ...alertMeta });
    }

    const { result } = sent;
    if (result.ok) {
      logger.info('エラー急増を運用メールに知らせました', { ...alertMeta, email_id: result.id });
      return NextResponse.json({ status: 'sent', ...counts });
    }

    // 送れなかった、または送らなかった (送信の設定が未完了)。権利を返して、15 分後の次の回でもう一度試せるようにする。
    // 失敗そのものの記録 (宛先をマスクした error) は sendEmail が済ませている
    await releaseClaim(supabase, claimedAt, settings.cooldownMinutes, logger);
    logger.warn(
      result.skipped
        ? 'エラー急増を検知しましたが、メールの送信設定が未完了のため通知を送っていません'
        : 'エラー急増を検知しましたが、通知メールを送れませんでした',
      { ...alertMeta, error_code: result.error.code },
    );
    return NextResponse.json({ status: result.skipped ? 'send_skipped' : 'send_failed', ...counts });
  } catch (err) {
    return internalError(ROUTE_NAME, err, { requestId });
  }
}

export async function GET(req: Request) {
  // CRON 認証 (Vercel Cron の Authorization header をチェック)。
  // #1044: 定数時間の比較、#1196: 入れ替え中の旧シークレット (CRON_SECRET_PREVIOUS) の受け付けは共通ヘルパーに集約
  const authError = await requireCronAuth(req);
  if (authError) return authError;

  const response = await checkAppLogErrors();
  // ログの書き込み (待たずに進む) が、応答の返却で止められないようにする。認証で断った要求にはログが無いので、ここまで来たものだけ
  waitUntil(new Promise<void>((resolve) => setTimeout(resolve, LOG_FLUSH_GRACE_MS)));
  return response;
}

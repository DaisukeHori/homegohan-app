/**
 * GET /api/cron/app-log-alerts — 本番エラーの急増を運用メールに知らせる (Vercel Cron。15 分おき。#1157)
 *
 * app_logs の level='error' を、直近 15 分ぶん function_name ごとに数える。合計がしきい値 (既定 20 件) を超えていたら、
 * 環境変数 OPS_ALERT_EMAIL のアドレスに 1 通だけメールを送る。しきい値などの定数と、メールに載せる内容の決め方は
 * src/lib/ops-alerts/app-log-error-spike.ts、文面は src/lib/emails/ops/app-log-error-spike.ts。
 *
 * 数えるものは 2 種類あり、別々に判定して別々に知らせる (#1493):
 *   - server: サーバーが書いた error (source <> 'client')。DB の app_log_error_counts。キー app_logs_error_spike・既定 20 件
 *   - client: ブラウザ・端末から POST /api/log で届いた error (source = 'client')。DB の app_log_client_error_counts。
 *     キー app_logs_client_error_spike・既定 100 件 (OPS_ALERT_CLIENT_ERROR_THRESHOLD で上書きできる)
 *   /api/log はログイン済みなら誰でも書けるので、まとめて数えると、利用者が error を書くだけでサーバーの障害の通知を鳴らせ、
 *   そのクールダウンで本物の障害の通知を止められてしまう。キーが別なので、クールダウンも共有しない。
 *   server を先に判定する (client の数え方が失敗しても、サーバーの障害の通知はその前に済んでいる)。
 * 3 つ目の種類 email_dead_letter (届けられなかったメール。#1193) は、server / client のあとに判定する:
 *   - 送信待ち (email_outbox) の dead のうち、まだ知らせていない (dead_alerted_at が NULL の) 行を template ごとに数える
 *     (DB の email_outbox_dead_counts。窓は持たない。宛先停止・退会・運用メール自身 (template が ops_ で始まる) は数えない)。
 *   - 1 件からで、キー email_dead_letter の権利 (claim_ops_alert) を取れたら、mark_email_outbox_dead_alerted でその行に印
 *     (dead_alerted_at = 権利の時刻) を付け、印を付けた行の件数で 1 通送る (文面は src/lib/emails/ops/email-dead-letter.ts)。
 *   - 権利が取れない回 (抑止の間) は印を付けないので、その間に dead になった行は抑止が明けた最初の回で知らせる。
 *   - 運用メールを送れずに権利を返すときは、unmark_email_outbox_dead_alerted で印も外し、次の回に持ち越す
 *     (docs/design/operator/10-logs-and-mail-retry.md §8)。
 *
 * 4 つ目の種類 cron_failure と 5 つ目の種類 pg_cron_stalled (定期処理の失敗の監視。#1125 の B) は、email_dead_letter のあとに判定する:
 *   - cron_failure: pg_cron の失敗した実行 (cron.job_run_details) と Vercel Cron の route の 500 (app_logs の internalError の行) のうち、
 *     まだ知らせていない (台帳 cron_failure_alerts に無い) ものを (出どころ, 名前) ごとに数える (DB の cron_failure_counts。窓は持たない)。
 *     1 件からで、キー cron_failure の権利を取れたら、mark_cron_failures_alerted で台帳に書き (alerted_at = 権利の時刻)、
 *     書けた件数で 1 通送る。送れずに権利を返すときは unmark_cron_failures_alerted で台帳の行も消す
 *     (docs/design/operator/11-ops-batches-non-billing.md §4・§6)。
 *   - pg_cron_stalled: 有効なジョブがあるのに最新の実行から OPS_ALERT_PG_CRON_STALL_MINUTES (既定 60) 分を超えていたら、
 *     キー pg_cron_stalled の権利を取って 1 通送る (台帳は使わない。止まっている間は抑止ごとに知らせる)。
 *   - 後ろの種類の失敗 (500) は前の種類の通知を止めない。順は server → client → email_dead_letter → cron_failure → pg_cron_stalled → cron_secret。
 *
 * 6 つ目の種類 cron_secret_drift と 7 つ目の種類 cron_secret_rotation (cron の共有シークレットのずれの検知。#1560) は、pg_cron_stalled のあとに判定する
 * (docs/design/operator/12-cron-secret-drift-monitor.md):
 *   - 各回で DB の send_cron_secret_probe() を呼ぶ。DB の関数が Vault の app_cron_secret を Bearer に付けて Edge Function cron-secret-probe を pg_net で 1 回呼ぶ
 *     (pg_cron の実際の呼び出しと同じ道。値はこの route に来ない)。次の回が cron_secret_probe_results() で前の回の確認の結果を読んで判定する。
 *   - cron_secret_drift: fail の所見 (食い違い 401・Edge に値が無い 503・Vault が無い / 空 / 復号できない・ゲートウェイの JWT 検証・未デプロイ・時間切れ・pg_net の不達)。
 *     キー cron_secret_drift・抑止は OPS_ALERT_COOLDOWN_MINUTES。台帳は使わない (続く間は抑止ごとに知らせる)。
 *   - cron_secret_rotation: warn の所見 (入れ替えの途中・Edge / Vercel の CRON_SECRET_PREVIOUS の残り・Vault が service role key)。
 *     キー cron_secret_rotation・抑止は OPS_ALERT_CRON_SECRET_ROTATION_COOLDOWN_MINUTES (既定 24 時間 = 注意の状態は 1 日 1 通まで)。ずれの通知には載せない。
 *   - Vercel の CRON_SECRET と Supabase 側 (Edge / Vault) は比べない。値もダイジェストも、メール・ログ・応答に出さない (載せるのは所見の id と件数だけ)。
 *
 * - 認証: Vercel Cron が付ける `Authorization: Bearer <CRON_SECRET>` (src/lib/cron-auth.ts の requireCronAuth。
 *   定数時間の比較と、入れ替え中の旧シークレット CRON_SECRET_PREVIOUS の受け付けは共通ヘルパーが行う)。
 * - OPS_ALERT_EMAIL が未設定なら、何もしない (info ログを 1 行残すだけ。DB にも触れない)。
 *   形がメールアドレスでないときも、送らずに warn ログを残す。
 * - しきい値とクールダウンは、環境変数 OPS_ALERT_ERROR_THRESHOLD / OPS_ALERT_CLIENT_ERROR_THRESHOLD / OPS_ALERT_COOLDOWN_MINUTES (と、停止の OPS_ALERT_PG_CRON_STALL_MINUTES) で
 *   上書きできる (どれも任意。不正な値は既定値に戻し、どの変数を無視したかを warn で残す)。窓 (15 分) は vercel.json の間隔と結びつくので変えない。
 *   クールダウンの分数は 2 種類で同じ値を使う。
 * - 同じアラートはクールダウン (既定 60 分) の間は送り直さない。「送ってよいか」は DB の claim_ops_alert が原子的に決める
 *   (Vercel Cron はまれに同じ回を 2 回呼ぶ。読んでから書く作りだと 2 通届く)。
 *   メールを送れなかったとき (送信の設定が未完了・送信待ちへの登録の失敗・例外など) は、release_ops_alert で権利を返す。
 *   送れていないのに「送った」と記録したままだと、設定が直ったあともクールダウンの間は通知が来ないため。
 *   ただし宛先が停止リストに載っている (suppressed)・文面の不備 (invalid_envelope) のときは返さない
 *   (送り直しても同じ結果で、15 分ごとの繰り返しになるため。#1577 の 8。NON_RELEASING_SEND_ERROR_CODES は
 *   src/lib/ops-alerts/send-release.ts にあり、backup-freshness の cron と共有する)。
 *   権利を取ったあとで関数ごと止められた (時間切れ・デプロイの切り替えなど) ときだけは返せず、次の通知が最大でクールダウンの分だけ遅れる (まれ)。
 * - メールが届くことには依存しない。sendEmail は送信待ち (email_outbox) に登録するだけで、送るのは worker
 *   (GET /api/cron/email-outbox)。登録できなかったときは sendEmail が app_logs に記録し (error)、この route も件数と関数名を warn で残す。応答は 200 のままにする
 *   (数える処理自体は正常に動いている。送れなかったかどうかは応答の status で分かる)。
 * - infra_alerts は書かない (インフラ画面は「未接続」のまま: #1180)。
 * - メールにも、ログにも、応答にも、ユーザー ID・メールアドレス・ログの本文は入れない。載せるのは件数と関数名だけ。
 *
 * 応答 (JSON): { status, total?, threshold?, window_minutes?, client?, email_dead_letter?, cron_failure?, pg_cron_stalled?, cron_secret_drift?, cron_secret_rotation? }
 *   status / total / threshold は server の判定。client は { status, total, threshold } で、client の判定 (#1493)。
 *   email_dead_letter は { status, total, threshold } で、届けられなかったメールの判定 (#1193。窓を持たないので window_minutes は付けない)。
 *   cron_failure は { status, total, threshold } で、定期処理の失敗の判定 (total は知らせた (印を付けた) 件数か、数えた件数。threshold は 0)。
   pg_cron_stalled は { status, total, threshold } で、pg_cron の停止の判定 (total は最新の実行からの分数、threshold は停止のしきい値の分数)。
 *   cron_secret_drift / cron_secret_rotation は { status, total, threshold } で、共有シークレットのずれ (fail) / 入れ替えの途中 (warn) の判定 (total は通知に載せた所見の件数、threshold は 0)。
   status: disabled / invalid_config / below_threshold / deduped / sent / send_skipped / send_failed
 *   (disabled / invalid_config のときは何も数えないので、total 以降と client・email_dead_letter は無い)
 *   DB の失敗 (数える・権利を取る) は 500。本文は汎用メッセージだけで、詳細は app_logs に残す (#1172)。
 */
import { NextResponse } from 'next/server';
import { describeCronSecretRotationState, requireCronAuth } from '@/lib/cron-auth';
import { internalError } from '@/lib/api/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/emails/send';
import type { SendEmailResult } from '@/lib/emails/send-result';
import { renderAppLogErrorSpikeEmail } from '@/lib/emails/ops/app-log-error-spike';
import { renderEmailDeadLetterEmail } from '@/lib/emails/ops/email-dead-letter';
import { renderCronFailureEmail } from '@/lib/emails/ops/cron-failure';
import { renderPgCronStalledEmail } from '@/lib/emails/ops/pg-cron-stalled';
import { renderCronSecretDriftEmail } from '@/lib/emails/ops/cron-secret-drift';
import { SUPER_ADMIN_EMAIL_OUTBOX_PATH } from '@/lib/emails/outbox';
import { getSiteUrl } from '@/lib/site-config';
import { resolveOpsAlertRecipient } from '@/lib/ops-alerts/recipient';
import { NON_RELEASING_SEND_ERROR_CODES } from '@/lib/ops-alerts/send-release';
import {
  APP_LOG_ALERT_COUNT_RPC,
  APP_LOG_ALERT_KEYS,
  APP_LOG_ALERT_MAX_FUNCTIONS,
  APP_LOG_ALERT_WINDOW_MINUTES,
  CRON_FAILURE_ALERT_THRESHOLD,
  EMAIL_DEAD_LETTER_ALERT_THRESHOLD,
  SUPER_ADMIN_LOGS_PATH,
  exceedsErrorThreshold,
  normalizeDeadCountRows,
  parseErrorCountRows,
  resolveAppLogAlertSettings,
  summarizeErrorCounts,
  type AppLogAlertScope,
  type AppLogAlertSettings,
  type AppLogErrorSpikeScope,
  type ErrorSummary,
} from '@/lib/ops-alerts/app-log-error-spike';
import {
  CRON_FAILURE_LOOKBACK_DAYS,
  judgePgCronStall,
  normalizeCronFailureRows,
  parsePgCronLastRun,
} from '@/lib/ops-alerts/cron-failure';
import {
  CRON_SECRET_ALERT_THRESHOLD,
  CRON_SECRET_PROBE_LOOKBACK_MINUTES,
  CRON_SECRET_PROBE_RESULT_LIMIT,
  CRON_SECRET_PROBE_RESULTS_RPC,
  CRON_SECRET_PROBE_SEND_RPC,
  cronSecretFindingIds,
  judgeCronSecretProbe,
  judgeVercelRotation,
  parseCronSecretProbeRows,
  parseCronSecretProbeSendResult,
  partitionCronSecretFindings,
  type CronSecretFinding,
} from '@/lib/ops-alerts/cron-secret-drift';

// sendEmail (Resend の SDK と node:crypto) は Node.js ランタイムで動く。Edge にはしない
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Next 14 の route handler では、dynamic = 'force-dynamic' だけでは fetch のキャッシュ (Data Cache) は切れなかった
// (force-dynamic だとリクエストの読み取りも追跡されず、ほかの route が cookies() などで暗黙に得ている「キャッシュしない」も効かない)。
// すると、supabase-js の RPC (POST) や Resend の呼び出しが「同じ内容なら前回の応答」で返ってしまい、
// 数えた件数も、送る権利 (claim_ops_alert) も、毎回同じ古い値になった。ローカルの動作確認で、DB を書き換えても応答が変わらなかった。
// Next 15 (#1444) では fetch は既定でキャッシュしないが、既定に頼らず、この route の fetch はすべてキャッシュしないと明示しておく。
export const fetchCache = 'force-no-store';
export const maxDuration = 60; // Vercel Pro: 60s OK (メールは送信待ちに登録するだけなので数秒で終わる)

/** 構造化ログ (app_logs.function_name) の名前。cron/process-menu-queue と同じ付け方 */
const ROUTE_NAME = 'cron/app-log-alerts';

type AdminClient = ReturnType<typeof getSupabaseAdmin>;
type Logger = ReturnType<typeof createLogger>;

/** 1 種類 (server / client / email_dead_letter / cron_failure / pg_cron_stalled / cron_secret_drift / cron_secret_rotation) の判定の結果 */
type SpikeStatus = 'below_threshold' | 'deduped' | 'sent' | 'send_skipped' | 'send_failed';

interface SpikeResult {
  readonly status: SpikeStatus;
  /** 窓の中の error の全体の件数 */
  readonly total: number;
  /** 使ったしきい値 */
  readonly threshold: number;
}

/** 判定できた (result) か、DB の失敗・想定外の例外で 500 を返す (response) か */
type SpikeOutcome = { readonly result: SpikeResult } | { readonly response: NextResponse };

/** ログの文の言い方。server は #1157 のときの文のまま */
const SCOPE_LOG_LABEL: Readonly<Record<AppLogAlertScope, string>> = {
  server: 'エラー急増',
  client: 'ブラウザ・端末のエラー急増',
  email_dead_letter: '届けられなかったメール',
  cron_failure: '定期処理の失敗',
  pg_cron_stalled: 'pg_cron の停止',
  cron_secret_drift: 'cron の共有シークレットのずれ',
  cron_secret_rotation: 'cron の共有シークレットの入れ替えの途中',
};

/** 届けられなかったメールの通知に使う DB の関数 (§5.2 (5)(7)(8))。数える関数は種類ごとの表から取る (値の型は 'email_outbox_dead_counts') */
const DEAD_LETTER_COUNT_RPC = APP_LOG_ALERT_COUNT_RPC.email_dead_letter;
const DEAD_LETTER_MARK_RPC = 'mark_email_outbox_dead_alerted';
const DEAD_LETTER_UNMARK_RPC = 'unmark_email_outbox_dead_alerted';

/**
 * 取った「送る権利」を返す。失敗しても例外にしない (すでに「送れなかった」という本題を抱えているため)。
 * 返せなかったときは、次の通知が最大でクールダウン (cooldownMinutes) 分遅れるだけ。
 */
async function releaseClaim(
  supabase: AdminClient,
  scope: AppLogAlertScope,
  claimedAt: string,
  cooldownMinutes: number,
  logger: Logger,
): Promise<void> {
  const message = `送る権利を返せませんでした。次の通知が最大 ${cooldownMinutes} 分遅れることがあります`;
  try {
    const { error } = await supabase.rpc('release_ops_alert', {
      p_alert_key: APP_LOG_ALERT_KEYS[scope],
      p_claimed_at: claimedAt,
    });
    if (error) {
      logger.warn(message, { scope, pg_code: error.code });
    }
  } catch (err) {
    logger.warn(message, {
      scope,
      error_name: err instanceof Error ? err.name : typeof err,
    });
  }
}

/**
 * 1 種類 (server / client) について: 数える → しきい値 → 送る権利を取る → メールを送る。
 * 種類ごとに、数える DB の関数・ops_alert_state のキー・しきい値が違う (クールダウンの分数と宛先は同じ)。
 */
async function checkScope(
  scope: AppLogErrorSpikeScope,
  supabase: AdminClient,
  recipient: string,
  settings: AppLogAlertSettings,
  requestId: string,
  logger: Logger,
): Promise<SpikeOutcome> {
  const rpcName = APP_LOG_ALERT_COUNT_RPC[scope];
  const threshold = scope === 'server' ? settings.errorThreshold : settings.clientErrorThreshold;

  // 1. 直近の窓の error を function_name ごとに数える (関数名と件数だけを返す DB の関数。本文・ユーザー ID は読まない)
  const counted = await supabase.rpc(rpcName, {
    p_window_minutes: APP_LOG_ALERT_WINDOW_MINUTES,
    p_limit: APP_LOG_ALERT_MAX_FUNCTIONS,
  });
  if (counted.error) {
    return { response: internalError(ROUTE_NAME, counted.error, { requestId, scope, rpc: rpcName }) };
  }
  const summary = summarizeErrorCounts(parseErrorCountRows(counted.data, rpcName));
  const counts = { total: summary.total, threshold };

  if (!exceedsErrorThreshold(summary.total, threshold)) {
    return { result: { status: 'below_threshold', ...counts } };
  }

  // 2. 送る権利を取る。クールダウン中 (直近 cooldownMinutes 分に、同じ種類の通知を送った。既定 60 分) なら NULL で、送らない
  const claimed = await supabase.rpc('claim_ops_alert', {
    p_alert_key: APP_LOG_ALERT_KEYS[scope],
    p_cooldown_minutes: settings.cooldownMinutes,
  });
  if (claimed.error) {
    return { response: internalError(ROUTE_NAME, claimed.error, { requestId, scope, rpc: 'claim_ops_alert' }) };
  }
  const claimedAt = typeof claimed.data === 'string' && claimed.data ? claimed.data : null;
  if (!claimedAt) {
    return { result: { status: 'deduped', ...counts } };
  }

  // 3. メールを作って送る。件数と関数名だけを載せる。
  // 権利を取ったあとの例外 (文面を作る・送る) はここで受け、必ず権利を返してから扱う
  // (sendEmail は配信の失敗で例外を投げない作りだが、想定外の例外でもクールダウンの沈黙を残さない)
  let sent: { readonly result: SendEmailResult } | { readonly thrown: unknown };
  try {
    const envelope = renderAppLogErrorSpikeEmail({
      scope,
      to_email: recipient,
      total: summary.total,
      window_minutes: APP_LOG_ALERT_WINDOW_MINUTES,
      threshold,
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
    scope,
    ...counts,
    window_minutes: APP_LOG_ALERT_WINDOW_MINUTES,
    other_count: summary.otherCount,
    functions: summary.functions,
  };

  if ('thrown' in sent) {
    await releaseClaim(supabase, scope, claimedAt, settings.cooldownMinutes, logger);
    return { response: internalError(ROUTE_NAME, sent.thrown, { requestId, stage: 'send_email', ...alertMeta }) };
  }

  const { result } = sent;
  const label = SCOPE_LOG_LABEL[scope];
  if (result.ok) {
    logger.info(`${label}を運用メールに知らせました`, { ...alertMeta, outbox_id: result.id });
    return { result: { status: 'sent', ...counts } };
  }

  // 送れなかった、または送らなかった。宛先停止・文面の不備は送り直しても同じなので、権利を返さない (抑止が効く。#1577 の 8)。
  // それ以外 (送信の設定が未完了・送信待ちへの登録の失敗など) は権利を返して、15 分後の次の回でもう一度試せるようにする。
  // 失敗そのものの記録 (宛先をマスクした error) は sendEmail が済ませている
  if (!NON_RELEASING_SEND_ERROR_CODES.has(result.error.code)) {
    await releaseClaim(supabase, scope, claimedAt, settings.cooldownMinutes, logger);
  }
  logger.warn(
    result.skipped
      ? `${label}を検知しましたが、メールの送信設定が未完了のため通知を送っていません`
      : `${label}を検知しましたが、通知メールを送れませんでした`,
    { ...alertMeta, error_code: result.error.code },
  );
  return { result: { status: result.skipped ? 'send_skipped' : 'send_failed', ...counts } };
}

/**
 * 運用メールを送れなかったときに、mark_email_outbox_dead_alerted で付けた印 (dead_alerted_at = 権利の時刻) を外し、次の回に持ち越す。
 * 失敗しても例外にしない (releaseClaim と同じ)。外せなかった行は通知の対象から外れたまま (送信待ちの画面には残る)。
 */
async function unmarkDeadLetters(supabase: AdminClient, alertedAt: string, logger: Logger): Promise<void> {
  const message = '届けられなかったメールの「知らせた」印を外せませんでした。該当の行は次の通知に入りません (送信待ちの画面には残ります)';
  try {
    const { error } = await supabase.rpc(DEAD_LETTER_UNMARK_RPC, { p_alerted_at: alertedAt });
    if (error) {
      logger.warn(message, { scope: 'email_dead_letter', pg_code: error.code });
    }
  } catch (err) {
    logger.warn(message, { scope: 'email_dead_letter', error_name: err instanceof Error ? err.name : typeof err });
  }
}

/** 権利を取ったあとの段 (印を付ける → 文面を作って送る) の結果 */
type DeadLetterNotice =
  | { readonly kind: 'notified'; readonly result: SendEmailResult; readonly summary: ErrorSummary }
  | { readonly kind: 'nothing_marked' }
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * 届けられなかったメール (email_outbox の dead) について: まだ知らせていない行を数える → 1 件から → 権利を取る → 印を付ける → 印を付けた件数で送る。
 * 窓は持たない。抑止の間 (権利が取れない回) と cron の発火の遅れの間に dead になった行も、印が付くまで毎回数える (R-13)。
 * 送れずに権利を返すときは、印も外す (§8.3)。
 */
async function checkEmailDeadLetters(
  supabase: AdminClient,
  recipient: string,
  settings: AppLogAlertSettings,
  requestId: string,
  logger: Logger,
): Promise<SpikeOutcome> {
  const scope = 'email_dead_letter' as const;
  const threshold = EMAIL_DEAD_LETTER_ALERT_THRESHOLD;

  // 1. まだ知らせていない dead を template ごとに数える (template と件数だけ。宛先・件名・本文は読まない)
  const counted = await supabase.rpc(DEAD_LETTER_COUNT_RPC, { p_limit: APP_LOG_ALERT_MAX_FUNCTIONS });
  if (counted.error) {
    return { response: internalError(ROUTE_NAME, counted.error, { requestId, scope, rpc: DEAD_LETTER_COUNT_RPC }) };
  }
  const pending = summarizeErrorCounts(parseErrorCountRows(normalizeDeadCountRows(counted.data), DEAD_LETTER_COUNT_RPC));
  if (!exceedsErrorThreshold(pending.total, threshold)) {
    return { result: { status: 'below_threshold', total: pending.total, threshold } };
  }

  // 2. 送る権利を取る。抑止の間なら NULL で、送らない。印も付けないので、その行は抑止が明けた最初の回でもう一度数えられる
  const claimed = await supabase.rpc('claim_ops_alert', {
    p_alert_key: APP_LOG_ALERT_KEYS[scope],
    p_cooldown_minutes: settings.cooldownMinutes,
  });
  if (claimed.error) {
    return { response: internalError(ROUTE_NAME, claimed.error, { requestId, scope, rpc: 'claim_ops_alert' }) };
  }
  const claimedAt = typeof claimed.data === 'string' && claimed.data ? claimed.data : null;
  if (!claimedAt) {
    return { result: { status: 'deduped', total: pending.total, threshold } };
  }

  // 3. 印を付け (dead_alerted_at = 権利の時刻)、印を付けた行の件数で文面を作って送る (数えたあとに dead になった行も、印が付けばこの通知に入る)。
  //    権利を取ったあとの RPC の失敗・応答の形の誤り・例外はここで受け、印と権利を返してから扱う
  let notice: DeadLetterNotice;
  try {
    const marked = await supabase.rpc(DEAD_LETTER_MARK_RPC, { p_alerted_at: claimedAt, p_limit: APP_LOG_ALERT_MAX_FUNCTIONS });
    if (marked.error) {
      notice = { kind: 'failed', error: marked.error };
    } else {
      const summary = summarizeErrorCounts(parseErrorCountRows(normalizeDeadCountRows(marked.data), DEAD_LETTER_MARK_RPC));
      if (summary.total === 0) {
        notice = { kind: 'nothing_marked' };
      } else {
        const envelope = renderEmailDeadLetterEmail({
          to_email: recipient,
          total: summary.total,
          cooldown_minutes: settings.cooldownMinutes,
          templates: summary.functions,
          other_count: summary.otherCount,
          outbox_url: `${getSiteUrl()}${SUPER_ADMIN_EMAIL_OUTBOX_PATH}`,
          detected_at: new Date(),
        });
        notice = { kind: 'notified', result: await sendEmail(envelope), summary };
      }
    }
  } catch (thrown) {
    notice = { kind: 'failed', error: thrown };
  }

  if (notice.kind === 'failed') {
    // 印の RPC がエラーを返しても、DB では付いていることがある (応答だけが失われた) ので、外す操作は必ず呼ぶ (付いていなければ 0 行)
    await unmarkDeadLetters(supabase, claimedAt, logger);
    await releaseClaim(supabase, scope, claimedAt, settings.cooldownMinutes, logger);
    return { response: internalError(ROUTE_NAME, notice.error, { requestId, scope, stage: 'mark_or_send' }) };
  }
  if (notice.kind === 'nothing_marked') {
    // 数えてから印を付けるまでに、行が再送 (queued) や掃除で dead でなくなった。知らせるものが無いので権利を返す
    await releaseClaim(supabase, scope, claimedAt, settings.cooldownMinutes, logger);
    return { result: { status: 'below_threshold', total: 0, threshold } };
  }

  const { result, summary } = notice;
  const counts = { total: summary.total, threshold };
  // ログには件数と文面の名前 (template) だけを残す。メールが届かなくても、ここから何が起きていたか分かる
  const alertMeta = { scope, ...counts, other_count: summary.otherCount, templates: summary.functions };
  const label = SCOPE_LOG_LABEL[scope];
  if (result.ok) {
    logger.info(`${label}を運用メールに知らせました`, { ...alertMeta, outbox_id: result.id });
    return { result: { status: 'sent', ...counts } };
  }
  // 送れなかった、または送らなかった (§8.3)。宛先停止・文面の不備は送り直しても同じなので、印も権利も返さない (抑止が効き、行は画面に残る)。
  // それ以外 (送信の設定が未完了・送信待ちへの登録の失敗など) は印と権利を返し、15 分後の次の回で同じ行をもう一度知らせる
  if (!NON_RELEASING_SEND_ERROR_CODES.has(result.error.code)) {
    await unmarkDeadLetters(supabase, claimedAt, logger);
    await releaseClaim(supabase, scope, claimedAt, settings.cooldownMinutes, logger);
  }
  logger.warn(
    result.skipped
      ? `${label}を検知しましたが、メールの送信設定が未完了のため通知を送っていません`
      : `${label}を検知しましたが、通知メールを送れませんでした`,
    { ...alertMeta, error_code: result.error.code },
  );
  return { result: { status: result.skipped ? 'send_skipped' : 'send_failed', ...counts } };
}

/** 定期処理の失敗の通知に使う DB の関数 (§5.2 (2)(3)(4)(5))。数える関数は種類ごとの表から取る */
const CRON_FAILURE_COUNT_RPC = APP_LOG_ALERT_COUNT_RPC.cron_failure;
const CRON_FAILURE_MARK_RPC = 'mark_cron_failures_alerted';
const CRON_FAILURE_UNMARK_RPC = 'unmark_cron_failures_alerted';
const PG_CRON_LAST_RUN_RPC = APP_LOG_ALERT_COUNT_RPC.pg_cron_stalled;

/** 送れなかったときに台帳の印 (alerted_at = 権利の時刻) を外し、次の回に持ち越す。失敗しても例外にしない (unmarkDeadLetters と同じ) */
async function unmarkCronFailures(supabase: AdminClient, alertedAt: string, logger: Logger): Promise<void> {
  const message = '定期処理の失敗の「知らせた」印を外せませんでした。該当の失敗は次の通知に入りません';
  try {
    const { error } = await supabase.rpc(CRON_FAILURE_UNMARK_RPC, { p_alerted_at: alertedAt });
    if (error) logger.warn(message, { scope: 'cron_failure', pg_code: error.code });
  } catch (err) {
    logger.warn(message, { scope: 'cron_failure', error_name: err instanceof Error ? err.name : typeof err });
  }
}

type CronFailureNotice =
  | { readonly kind: 'notified'; readonly result: SendEmailResult; readonly summary: ErrorSummary }
  | { readonly kind: 'nothing_marked' }
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * 定期処理の失敗: まだ知らせていない失敗を数える → 1 件から → 権利を取る → 台帳に書く → 書けた件数で送る。
 * 窓は持たない。送れずに権利を返すときは台帳の行も消す (checkEmailDeadLetters と同じ順序)
 */
async function checkCronFailures(
  supabase: AdminClient,
  recipient: string,
  settings: AppLogAlertSettings,
  requestId: string,
  logger: Logger,
): Promise<SpikeOutcome> {
  const scope = 'cron_failure' as const;
  const threshold = CRON_FAILURE_ALERT_THRESHOLD;

  // 1. 数える (名前と件数だけ)
  const counted = await supabase.rpc(CRON_FAILURE_COUNT_RPC, { p_limit: APP_LOG_ALERT_MAX_FUNCTIONS });
  if (counted.error) {
    return { response: internalError(ROUTE_NAME, counted.error, { requestId, scope, rpc: CRON_FAILURE_COUNT_RPC }) };
  }
  const pending = summarizeErrorCounts(parseErrorCountRows(normalizeCronFailureRows(counted.data, CRON_FAILURE_COUNT_RPC), CRON_FAILURE_COUNT_RPC));
  if (!exceedsErrorThreshold(pending.total, threshold)) {
    return { result: { status: 'below_threshold', total: pending.total, threshold } };
  }

  // 2. 権利を取る。抑止の間なら NULL (台帳には書かないので、抑止が明けた最初の回でもう一度数えられる)
  const claimed = await supabase.rpc('claim_ops_alert', { p_alert_key: APP_LOG_ALERT_KEYS[scope], p_cooldown_minutes: settings.cooldownMinutes });
  if (claimed.error) {
    return { response: internalError(ROUTE_NAME, claimed.error, { requestId, scope, rpc: 'claim_ops_alert' }) };
  }
  const claimedAt = typeof claimed.data === 'string' && claimed.data ? claimed.data : null;
  if (!claimedAt) {
    return { result: { status: 'deduped', total: pending.total, threshold } };
  }

  // 3. 台帳に書き (alerted_at = 権利の時刻)、書けた行の件数で文面を作って送る
  let notice: CronFailureNotice;
  try {
    const marked = await supabase.rpc(CRON_FAILURE_MARK_RPC, { p_alerted_at: claimedAt, p_limit: APP_LOG_ALERT_MAX_FUNCTIONS });
    if (marked.error) {
      notice = { kind: 'failed', error: marked.error };
    } else {
      const summary = summarizeErrorCounts(parseErrorCountRows(normalizeCronFailureRows(marked.data, CRON_FAILURE_MARK_RPC), CRON_FAILURE_MARK_RPC));
      if (summary.total === 0) {
        notice = { kind: 'nothing_marked' };
      } else {
        const envelope = renderCronFailureEmail({
          to_email: recipient,
          total: summary.total,
          lookback_days: CRON_FAILURE_LOOKBACK_DAYS,
          cooldown_minutes: settings.cooldownMinutes,
          failures: summary.functions,
          other_count: summary.otherCount,
          logs_url: `${getSiteUrl()}${SUPER_ADMIN_LOGS_PATH}`,
          detected_at: new Date(),
        });
        notice = { kind: 'notified', result: await sendEmail(envelope), summary };
      }
    }
  } catch (thrown) {
    notice = { kind: 'failed', error: thrown };
  }

  if (notice.kind === 'failed') {
    await unmarkCronFailures(supabase, claimedAt, logger);
    await releaseClaim(supabase, scope, claimedAt, settings.cooldownMinutes, logger);
    return { response: internalError(ROUTE_NAME, notice.error, { requestId, scope, stage: 'mark_or_send' }) };
  }
  if (notice.kind === 'nothing_marked') {
    // 数えてから台帳に書くまでに、掃除で失敗の行が消えた (まれ)。知らせるものが無いので権利を返す
    await releaseClaim(supabase, scope, claimedAt, settings.cooldownMinutes, logger);
    return { result: { status: 'below_threshold', total: 0, threshold } };
  }

  const { result, summary } = notice;
  const counts = { total: summary.total, threshold };
  const alertMeta = { scope, ...counts, other_count: summary.otherCount, failures: summary.functions };
  const label = SCOPE_LOG_LABEL[scope];
  if (result.ok) {
    logger.info(`${label}を運用メールに知らせました`, { ...alertMeta, outbox_id: result.id });
    return { result: { status: 'sent', ...counts } };
  }
  if (!NON_RELEASING_SEND_ERROR_CODES.has(result.error.code)) {
    await unmarkCronFailures(supabase, claimedAt, logger);
    await releaseClaim(supabase, scope, claimedAt, settings.cooldownMinutes, logger);
  }
  logger.warn(
    result.skipped
      ? `${label}を検知しましたが、メールの送信設定が未完了のため通知を送っていません`
      : `${label}を検知しましたが、通知メールを送れませんでした`,
    { ...alertMeta, error_code: result.error.code },
  );
  return { result: { status: result.skipped ? 'send_skipped' : 'send_failed', ...counts } };
}

/** pg_cron の停止: 最新の実行の時刻を読む → しきい値 → 権利を取る → 送る。台帳は使わない (止まっている間は抑止ごとに知らせる) */
async function checkPgCronStalled(
  supabase: AdminClient,
  recipient: string,
  settings: AppLogAlertSettings,
  requestId: string,
  logger: Logger,
): Promise<SpikeOutcome> {
  const scope = 'pg_cron_stalled' as const;
  const threshold = settings.pgCronStallMinutes;

  const read = await supabase.rpc(PG_CRON_LAST_RUN_RPC);
  if (read.error) {
    return { response: internalError(ROUTE_NAME, read.error, { requestId, scope, rpc: PG_CRON_LAST_RUN_RPC }) };
  }
  const run = parsePgCronLastRun(read.data, PG_CRON_LAST_RUN_RPC);
  const judged = judgePgCronStall(run, new Date(), threshold);
  const counts = { total: judged.minutes_since_last_run, threshold };
  if (!judged.stalled) {
    return { result: { status: 'below_threshold', ...counts } };
  }

  const claimed = await supabase.rpc('claim_ops_alert', { p_alert_key: APP_LOG_ALERT_KEYS[scope], p_cooldown_minutes: settings.cooldownMinutes });
  if (claimed.error) {
    return { response: internalError(ROUTE_NAME, claimed.error, { requestId, scope, rpc: 'claim_ops_alert' }) };
  }
  const claimedAt = typeof claimed.data === 'string' && claimed.data ? claimed.data : null;
  if (!claimedAt) {
    return { result: { status: 'deduped', ...counts } };
  }

  let sent: { readonly result: SendEmailResult } | { readonly thrown: unknown };
  try {
    const envelope = renderPgCronStalledEmail({
      to_email: recipient,
      minutes_since_last_run: judged.minutes_since_last_run,
      last_run_at: run.last_run_at === null ? null : new Date(run.last_run_at),
      active_jobs: run.active_jobs,
      stall_minutes: threshold,
      cooldown_minutes: settings.cooldownMinutes,
      logs_url: `${getSiteUrl()}${SUPER_ADMIN_LOGS_PATH}`,
      detected_at: new Date(),
    });
    sent = { result: await sendEmail(envelope) };
  } catch (thrown) {
    sent = { thrown };
  }
  const alertMeta = { scope, ...counts, active_jobs: run.active_jobs };
  if ('thrown' in sent) {
    await releaseClaim(supabase, scope, claimedAt, settings.cooldownMinutes, logger);
    return { response: internalError(ROUTE_NAME, sent.thrown, { requestId, stage: 'send_email', ...alertMeta }) };
  }
  const { result } = sent;
  const label = SCOPE_LOG_LABEL[scope];
  if (result.ok) {
    logger.info(`${label}を運用メールに知らせました`, { ...alertMeta, outbox_id: result.id });
    return { result: { status: 'sent', ...counts } };
  }
  if (!NON_RELEASING_SEND_ERROR_CODES.has(result.error.code)) {
    await releaseClaim(supabase, scope, claimedAt, settings.cooldownMinutes, logger);
  }
  logger.warn(
    result.skipped
      ? `${label}を検知しましたが、メールの送信設定が未完了のため通知を送っていません`
      : `${label}を検知しましたが、通知メールを送れませんでした`,
    { ...alertMeta, error_code: result.error.code },
  );
  return { result: { status: result.skipped ? 'send_skipped' : 'send_failed', ...counts } };
}

/** 2 つの種類 (ずれ = fail / 入れ替えの途中 = warn) の結果。route の応答のキーと同じ */
interface CronSecretOutcome {
  readonly cron_secret_drift: SpikeResult;
  readonly cron_secret_rotation: SpikeResult;
}

/**
 * 所見があれば権利を取って 1 通送る (台帳は無い。続く間は抑止ごとに知らせる: checkPgCronStalled と同じ形)。
 * scope ごとにキーと抑止の分数が違う。文面には所見の題と対処だけを載せる (値・ダイジェストは所見に無い)。
 */
async function notifyCronSecret(
  scope: 'cron_secret_drift' | 'cron_secret_rotation',
  findings: readonly CronSecretFinding[],
  cooldownMinutes: number,
  supabase: AdminClient,
  recipient: string,
  requestId: string,
  logger: Logger,
): Promise<SpikeOutcome> {
  const threshold = CRON_SECRET_ALERT_THRESHOLD;
  const counts = { total: findings.length, threshold };
  if (!exceedsErrorThreshold(findings.length, threshold)) {
    return { result: { status: 'below_threshold', ...counts } };
  }
  const claimed = await supabase.rpc('claim_ops_alert', { p_alert_key: APP_LOG_ALERT_KEYS[scope], p_cooldown_minutes: cooldownMinutes });
  if (claimed.error) {
    return { response: internalError(ROUTE_NAME, claimed.error, { requestId, scope, rpc: 'claim_ops_alert' }) };
  }
  const claimedAt = typeof claimed.data === 'string' && claimed.data ? claimed.data : null;
  if (!claimedAt) {
    return { result: { status: 'deduped', ...counts } };
  }
  let sent: { readonly result: SendEmailResult } | { readonly thrown: unknown };
  try {
    const envelope = renderCronSecretDriftEmail({
      kind: scope === 'cron_secret_drift' ? 'drift' : 'rotation',
      to_email: recipient,
      findings,
      cooldown_minutes: cooldownMinutes,
      logs_url: `${getSiteUrl()}${SUPER_ADMIN_LOGS_PATH}`,
      detected_at: new Date(),
    });
    sent = { result: await sendEmail(envelope) };
  } catch (thrown) {
    sent = { thrown };
  }
  // ログには所見の id と件数だけ (題・対処の文も出さない。id から表を引ける)
  const alertMeta = { scope, ...counts, finding_ids: cronSecretFindingIds(findings) };
  if ('thrown' in sent) {
    await releaseClaim(supabase, scope, claimedAt, cooldownMinutes, logger);
    return { response: internalError(ROUTE_NAME, sent.thrown, { requestId, stage: 'send_email', ...alertMeta }) };
  }
  const { result } = sent;
  const label = SCOPE_LOG_LABEL[scope];
  if (result.ok) {
    logger.info(`${label}を運用メールに知らせました`, { ...alertMeta, outbox_id: result.id });
    return { result: { status: 'sent', ...counts } };
  }
  if (!NON_RELEASING_SEND_ERROR_CODES.has(result.error.code)) {
    await releaseClaim(supabase, scope, claimedAt, cooldownMinutes, logger);
  }
  logger.warn(
    result.skipped
      ? `${label}を検知しましたが、メールの送信設定が未完了のため通知を送っていません`
      : `${label}を検知しましたが、通知メールを送れませんでした`,
    { ...alertMeta, error_code: result.error.code },
  );
  return { result: { status: result.skipped ? 'send_skipped' : 'send_failed', ...counts } };
}

/**
 * cron の共有シークレットのずれ (#1560): 前の回の確認の結果を読む → 判定 → ずれ (fail) と入れ替えの途中 (warn) をそれぞれ通知 → 次の回のための確認を送る。
 * 読む・送る RPC の失敗と応答の形の誤りは 500 (前の 5 種類の通知は済んでいる)。通知の失敗で 500 になった回は確認を送らない (次の回が前の確認を読み直す)。
 */
async function checkCronSecretDrift(
  supabase: AdminClient,
  recipient: string,
  settings: AppLogAlertSettings,
  requestId: string,
  logger: Logger,
): Promise<{ readonly result: CronSecretOutcome } | { readonly response: NextResponse }> {
  // 1. 前の回の確認の結果 (見る範囲 60 分・新しい順に 8 行)。判定に要る項目だけが返る
  const read = await supabase.rpc(CRON_SECRET_PROBE_RESULTS_RPC, {
    p_lookback_minutes: CRON_SECRET_PROBE_LOOKBACK_MINUTES,
    p_limit: CRON_SECRET_PROBE_RESULT_LIMIT,
  });
  if (read.error) {
    return { response: internalError(ROUTE_NAME, read.error, { requestId, scope: 'cron_secret_drift', rpc: CRON_SECRET_PROBE_RESULTS_RPC }) };
  }
  const now = new Date();
  const probe = judgeCronSecretProbe(parseCronSecretProbeRows(read.data, CRON_SECRET_PROBE_RESULTS_RPC), now);
  const findings = [...probe.findings, ...judgeVercelRotation(describeCronSecretRotationState())];
  const { fails, warns } = partitionCronSecretFindings(findings);

  // 2. ずれ (fail)。抑止は既存の OPS_ALERT_COOLDOWN_MINUTES。warn は載せない (注意は 3. の通知だけで 1 日 1 通まで: 設計 §0.4 の Q-2)
  const drift = await notifyCronSecret('cron_secret_drift', fails, settings.cooldownMinutes, supabase, recipient, requestId, logger);
  if ('response' in drift) return drift;

  // 3. 入れ替えの途中・残り (warn)。抑止は OPS_ALERT_CRON_SECRET_ROTATION_COOLDOWN_MINUTES (既定 24 時間)
  const rotation = await notifyCronSecret('cron_secret_rotation', warns, settings.cronSecretRotationCooldownMinutes, supabase, recipient, requestId, logger);
  if ('response' in rotation) return rotation;

  // 4. 次の回のための確認を送る (Vault の値は DB の中で Bearer に付くだけで、ここには来ない)
  const sent = await supabase.rpc(CRON_SECRET_PROBE_SEND_RPC);
  if (sent.error) {
    return { response: internalError(ROUTE_NAME, sent.error, { requestId, scope: 'cron_secret_drift', rpc: CRON_SECRET_PROBE_SEND_RPC }) };
  }
  parseCronSecretProbeSendResult(sent.data, CRON_SECRET_PROBE_SEND_RPC);

  return { result: { cron_secret_drift: drift.result, cron_secret_rotation: rotation.result } };
}

/** 認証のあとの本体: 数える → しきい値 → 送る権利を取る → メールを送る */
async function checkAppLogErrors(): Promise<NextResponse> {
  const requestId = generateRequestId();
  const logger = createLogger(ROUTE_NAME, requestId);

  // 宛先。未設定なら何もしない (本番は、オーナーが決めて設定するまで未設定)。
  // 読み口は backup-freshness と共有する (src/lib/ops-alerts/recipient.ts。#1129)。値そのもの (メールアドレス) はログに出さない
  const recipient = resolveOpsAlertRecipient();
  if (recipient.status === 'disabled') {
    logger.info('OPS_ALERT_EMAIL が未設定のため、エラー急増の通知は行いません');
    return NextResponse.json({ status: 'disabled' });
  }
  if (recipient.status === 'invalid_config') {
    logger.warn('OPS_ALERT_EMAIL がメールアドレス (1 つ) の形ではないため、エラー急増の通知は行いません');
    return NextResponse.json({ status: 'invalid_config' });
  }

  // しきい値とクールダウン。運用で変えるときは環境変数で上書きする (未設定なら既定の 20 件・100 件・60 分)。
  // 値が不正なら既定値に戻して進め (通知は止めない)、どの変数を無視したかだけを warn で残す (値は出さない)
  const settings = resolveAppLogAlertSettings({
    errorThreshold: process.env.OPS_ALERT_ERROR_THRESHOLD,
    clientErrorThreshold: process.env.OPS_ALERT_CLIENT_ERROR_THRESHOLD,
    cooldownMinutes: process.env.OPS_ALERT_COOLDOWN_MINUTES,
    pgCronStallMinutes: process.env.OPS_ALERT_PG_CRON_STALL_MINUTES,
    cronSecretRotationCooldownMinutes: process.env.OPS_ALERT_CRON_SECRET_ROTATION_COOLDOWN_MINUTES,
  });
  if (settings.ignored.length > 0) {
    logger.warn('しきい値・クールダウンの環境変数の値が正しくないため、既定値を使います', {
      ignored_env: settings.ignored,
    });
  }

  try {
    const supabase = getSupabaseAdmin();

    // サーバーの error を先に判定する。client の数え方が失敗しても、サーバーの障害の通知はここで済んでいる
    const server = await checkScope('server', supabase, recipient.email, settings, requestId, logger);
    if ('response' in server) return server.response;

    // ブラウザ・端末から届いた error (#1493)。別のキー・別のしきい値で、server の結果とは独立に判定する
    const client = await checkScope('client', supabase, recipient.email, settings, requestId, logger);
    if ('response' in client) return client.response;

    // 届けられなかったメール (#1193)。server / client とは独立に判定する (ここが失敗しても、前の 2 つの通知は済んでいる)
    const deadLetter = await checkEmailDeadLetters(supabase, recipient.email, settings, requestId, logger);
    if ('response' in deadLetter) return deadLetter.response;

    // 定期処理の失敗 (#1125 の B)。ここまでの通知とは独立に判定する (ここが失敗しても、前の 3 つの通知は済んでいる)
    const cronFailure = await checkCronFailures(supabase, recipient.email, settings, requestId, logger);
    if ('response' in cronFailure) return cronFailure.response;

    // pg_cron の停止 (#1125 の B)。失敗の行が増えない止まり方を見る
    const pgCronStalled = await checkPgCronStalled(supabase, recipient.email, settings, requestId, logger);
    if ('response' in pgCronStalled) return pgCronStalled.response;

    // cron の共有シークレットのずれ・入れ替えの途中 (#1560)。前の回の確認の結果を読んで通知し、次の回のための確認を送る
    const cronSecret = await checkCronSecretDrift(supabase, recipient.email, settings, requestId, logger);
    if ('response' in cronSecret) return cronSecret.response;

    return NextResponse.json({
      ...server.result,
      window_minutes: APP_LOG_ALERT_WINDOW_MINUTES,
      client: client.result,
      email_dead_letter: deadLetter.result,
      cron_failure: cronFailure.result,
      pg_cron_stalled: pgCronStalled.result,
      cron_secret_drift: cronSecret.result.cron_secret_drift,
      cron_secret_rotation: cronSecret.result.cron_secret_rotation,
    });
  } catch (err) {
    return internalError(ROUTE_NAME, err, { requestId });
  }
}

export async function GET(req: Request) {
  // CRON 認証 (Vercel Cron の Authorization header をチェック)。
  // #1044: 定数時間の比較、#1196: 入れ替え中の旧シークレット (CRON_SECRET_PREVIOUS) の受け付けは共通ヘルパーに集約
  const authError = await requireCronAuth(req);
  if (authError) return authError;

  // この route の最後のログ (送れなかったときの件数と関数名) は、メールが届かない間の唯一の手がかり。
  // その保存は createLogger が 1 行ごとに、終わるまで関数を止めさせない (#1909)。route では延命しない
  return checkAppLogErrors();
}

/**
 * AI 相談の提案の行 (ai_action_logs) を、実行のあとに書き戻す (#2195 V2)。
 *
 * 実行の API (POST /api/ai/consultation/actions/[actionId]/execute) と会話の続きの POST の自動実行
 * (src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts) は、実行の前に行を実行中の印 (approved) にし、
 * 実行が終わったら executed / pending / failed に書き戻す (src/lib/ai/consultation-action-lifecycle.ts の決まり)。
 * 書き戻しが 1 回の失敗 (接続の切れなど) で終わると、行は実行中の印のまま残り、成功した提案のカードが相談を開き直すたびに出て、
 * やり直せる失敗も「実行する」で押せなくなる。そこで 1 回だけ書き直し、それでも失敗したら構造化ログに残して失敗を返す
 * (呼び出し側は「実行する」を出さない。行が実行中の印のままのカードは、その場でも開き直しても「実行できたかを確かめられない」の
 * 案内になる。#2201 U3)。
 *
 * 書くのは service role のクライアント (getAiActionLogWriter。src/lib/ai/ai-action-log-writer.ts。#2283 Y1) で、
 * 呼び出し側は、行の相談の持ち主が本人であること (isAiActionLogOwnedBy / isConsultationSessionOwnedBy) を確かめてから渡す。
 * 利用者のセッションのクライアントでは書けない (supabase/migrations/20261107120000_ai_action_logs_select_only.sql (#2291) で
 * 利用者には読むだけに絞った)。
 *
 * 書き込みは、行が実行中の印 (approved) のときだけ書く条件つきの 1 文にする (#2295)。1 回目が DB には書けたのに応答が失われて
 * 失敗になると、以前の無条件の 2 回目は、その間に別の操作が進めた行 (例: 1 回目で pending に戻した行を、別の画面の「断る」が
 * rejected にした) を上書きしえた。条件に合う行が無い (0 行) ときは、行がもう実行中の印でない (前の試みが書けた・ほかの操作が
 * 先に進めた) ので、書き直さずに書けたとして返す。呼び出し側 (execute の POST・messages の POST の自動実行) は、どれも行を
 * 実行中の印にしてから (POST は pending → approved の条件つきの 1 文、自動実行は approved で作る) 書き戻す。
 *
 * サーバーだけで読む (ブラウザでは読まない)。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { errorCodeOf, toLoggableError } from '@/lib/api/errors';
import { AI_ACTION_LOG_STATUS } from '@/lib/ai/consultation-action-lifecycle';

/**
 * 書き戻しを試す回数 (1 回目 + やり直し 1 回)。一時的な失敗を 1 回だけ吸収する。
 * 書き戻しは応答を返す前に待つので、回数を増やすと関数の時間切れに近づく (時間切れでも行は実行中の印のまま残る)
 */
export const AI_ACTION_LOG_WRITE_BACK_ATTEMPTS = 2;

/** 書き戻しに使う DB の口 (from だけ。service role の getAiActionLogWriter() を渡す) */
export type AiActionLogWriter = Pick<SupabaseClient, 'from'>;

/** 1 回目の試みで条件 (実行中の印) に合う行が無かったときの warn の文 (想定外: 呼び出し側は実行中の印にしてから書き戻す) */
export const AI_ACTION_LOG_WRITE_BACK_NOT_RUNNING_LOG =
  'AI 相談の提案の行を書き戻そうとしたら、行がもう実行中の印ではありませんでした (書き戻しませんでした)';

/**
 * 行を書き戻す。行が実行中の印 (approved) のときだけ書く。失敗したら 1 回だけ書き直す。
 * 条件に合う行が無ければ (0 行) 書き直さずに null を返す (上書きしない。1 回目の試みで 0 行なら warn を残す)。
 * 最後まで書けなかったら構造化ログに残し、その失敗を返す (書けたら null)
 *
 * @param routeName ログの function_name (呼び出した route)
 */
export async function writeBackAiActionLog(
  actionLogDb: AiActionLogWriter,
  routeName: string,
  ctx: { userId: string; actionLogId: string; actionType: string },
  payload: Record<string, unknown>,
): Promise<{ error: unknown }> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= AI_ACTION_LOG_WRITE_BACK_ATTEMPTS; attempt += 1) {
    const { data, error } = await actionLogDb
      .from('ai_action_logs')
      .update(payload)
      .eq('id', ctx.actionLogId)
      .eq('status', AI_ACTION_LOG_STATUS.running)
      .select('id')
      .maybeSingle();
    if (error) {
      lastError = error;
      continue;
    }
    if (!data && attempt === 1) warnNotRunning(routeName, ctx, payload);
    // 書けた、または行がもう実行中の印でない (前の試みが書けた・ほかの操作が先に進めた): どちらも書き直さない
    return { error: null };
  }
  try {
    const errorCode = errorCodeOf(lastError);
    createLogger(routeName, generateRequestId())
      .withUser(ctx.userId)
      .error('AI 相談の提案の行を実行のあとに書き戻せませんでした (実行中の印のまま残ります)', toLoggableError(lastError), {
        action_id: ctx.actionLogId,
        action_type: ctx.actionType,
        status: payload.status,
        attempts: AI_ACTION_LOG_WRITE_BACK_ATTEMPTS,
        ...(errorCode ? { error_code: errorCode } : {}),
      });
  } catch (loggingError) {
    // 記録に失敗しても、書き戻しの失敗は呼び出し側へ返す (ここで投げると、実行の結果が 500 に化ける)
    console.error(`[${routeName}] 書き戻しの失敗の構造化ログへの記録に失敗しました`, lastError, loggingError);
  }
  return { error: lastError };
}

/** 1 回目の試みで行が実行中の印でなかったことを構造化ログに warn で残す (記録に失敗しても書き戻しの結果は変えない) */
function warnNotRunning(
  routeName: string,
  ctx: { userId: string; actionLogId: string; actionType: string },
  payload: Record<string, unknown>,
): void {
  try {
    createLogger(routeName, generateRequestId()).withUser(ctx.userId).warn(AI_ACTION_LOG_WRITE_BACK_NOT_RUNNING_LOG, {
      action_id: ctx.actionLogId,
      action_type: ctx.actionType,
      status: payload.status,
    });
  } catch (loggingError) {
    console.error(`[${routeName}] 書き戻しの warn の構造化ログへの記録に失敗しました`, loggingError);
  }
}

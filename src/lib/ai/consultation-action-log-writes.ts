/**
 * AI 相談の提案の行 (ai_action_logs) を、実行のあとに書き戻す (#2195 V2)。
 *
 * 実行の API (POST /api/ai/consultation/actions/[actionId]/execute) と会話の続きの POST の自動実行
 * (src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts) は、実行の前に行を実行中の印 (approved) にし、
 * 実行が終わったら executed / pending / failed に書き戻す (src/lib/ai/consultation-action-lifecycle.ts の決まり)。
 * 書き戻しが 1 回の失敗 (接続の切れなど) で終わると、行は実行中の印のまま残り、成功した提案のカードが相談を開き直すたびに出て、
 * やり直せる失敗も「実行する」で押せなくなる。そこで 1 回だけ書き直し、それでも失敗したら構造化ログに残して失敗を返す
 * (呼び出し側は「実行する」を出さない。行が実行中の印のままのカードは「実行中か実行済み」の案内になる)。
 *
 * サーバーだけで読む (ブラウザでは読まない)。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { errorCodeOf, toLoggableError } from '@/lib/api/errors';

/**
 * 書き戻しを試す回数 (1 回目 + やり直し 1 回)。一時的な失敗を 1 回だけ吸収する。
 * 書き戻しは応答を返す前に待つので、回数を増やすと関数の時間切れに近づく (時間切れでも行は実行中の印のまま残る)
 */
export const AI_ACTION_LOG_WRITE_BACK_ATTEMPTS = 2;

/** 書き戻しに使う DB の口 (from だけ) */
export type AiActionLogWriter = Pick<SupabaseClient, 'from'>;

/**
 * 行を書き戻す。失敗したら 1 回だけ書き直す。最後まで書けなかったら構造化ログに残し、その失敗を返す (書けたら null)
 *
 * @param routeName ログの function_name (呼び出した route)
 */
export async function writeBackAiActionLog(
  supabase: AiActionLogWriter,
  routeName: string,
  ctx: { userId: string; actionLogId: string; actionType: string },
  payload: Record<string, unknown>,
): Promise<{ error: unknown }> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= AI_ACTION_LOG_WRITE_BACK_ATTEMPTS; attempt += 1) {
    const { error } = await supabase.from('ai_action_logs').update(payload).eq('id', ctx.actionLogId);
    if (!error) return { error: null };
    lastError = error;
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

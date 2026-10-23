/**
 * GET /api/super-admin/llm/usage  — LLM 使用量ダッシュボード
 * operator/02-api-spec.md §8 + operator/06-ai-llm.md §4 準拠
 *
 * llm_usage_logs の実際の列は input_tokens / output_tokens / total_tokens / estimated_cost_usd。
 * 以前は存在しない prompt_tokens / completion_tokens / cost_usd を select していたため、
 * PostgREST が 42703 で失敗し、この API は常に 500 になっていた (#1306)。
 * 画面が読むレスポンスの項目名 (cost_usd など) は変えず、値は estimated_cost_usd から作る。
 * 今は列を DB の関数の中で読む (#1498)。関数が実在する列だけを読むことは、実 DB の
 * tests/integration/security/llm-usage-summary.test.ts と super-admin-columns.test.ts で確かめる。
 *
 * 期間 (開始日・終了日) と日次の系列は JST の暦日で決める (#1433)。created_at は timestamptz なので、
 * 日付の文字列をそのまま渡さず (DB は UTC の 0 時 = JST 9 時と読み、JST の 0:00〜8:59 の行が前日に入る)、
 * JST 0 時の時刻にしてから絞る。日次の系列も created_at を JST の暦日にまとめる (DB の関数の中で)。
 *
 * 集計は DB の関数 llm_usage_summary (supabase/migrations/20261011110000_llm_usage_summary.sql) で行う (#1498)。
 * 以前は行を 5,000 行まで読んで集計していたが、行は PostgREST の max_rows (既定 1,000) でも打ち切られるので、
 * 1,000 行を超える期間の合計は実際より小さく、異常使用 (1 人・JST の 1 日に 5,000 回超) は事実上判定できなかった。
 * 関数は全利用者の使用量を返すので service_role だけが呼べる。requireRole(['super_admin']) を通ったあとに
 * service role のクライアント (getSupabaseAdmin) で呼ぶ。
 * 開始日が終了日より後の期間は、関数を呼ぶ前に 400 (VALIDATION_ERROR) にする (関数は 22023 で拒むので、通すと 500 になる)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { jstDayRangeTimestamps, llmUsageRange } from '@/lib/jst-day-ranges';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { authFailureNested } from '@/lib/api/error-responses';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { LLM_USAGE_FROM_AFTER_TO_MESSAGE, LLMUsageQuerySchema } from '@/lib/super-admin/llm-schemas';
import {
  LLM_USAGE_SUMMARY_RPC,
  LlmUsageSummaryRpcSchema,
  llmUsageSummaryRpcArgs,
  toLlmUsageResponseData,
} from '@/lib/super-admin/llm-usage-summary';

export async function GET(request: NextRequest) {
  const logger = createLogger('GET /api/super-admin/llm/usage', generateRequestId());
  try {
    const user = await requireRole(['super_admin']);
    const { searchParams } = new URL(request.url);

    const parsed = LLMUsageQuerySchema.safeParse(Object.fromEntries(searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }

    const { period, from, to, model, function: functionName, provider } = parsed.data;

    // 期間の計算 (開始日・終了日の既定は JST の暦日。#1433)
    const { fromDate, toDate } = llmUsageRange({ period, from, to });
    // 開始日が終了日より後の期間 (custom の from > to、7d / 30d に過去の to を渡したとき) は入力の誤りなので 400 にし、DB には触れない。
    // DB の関数は開始の時刻 ≥ 終わりの時刻を 22023 で拒む (呼び出し側の誤りの見張り) ので、通すとサーバーの障害 (500) として
    // 記録されてしまう (#1498)。日付は YYYY-MM-DD なので文字列の大小が暦日の前後と一致する
    if (fromDate > toDate) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: '入力値が不正です',
            details: { formErrors: [], fieldErrors: { from: [LLM_USAGE_FROM_AFTER_TO_MESSAGE] } },
          },
        },
        { status: 400 },
      );
    }
    // created_at (timestamptz) と比べる時刻。開始日の JST 0 時から、終了日の翌日の JST 0 時の手前まで
    const { fromTimestamp, toTimestampExclusive } = jstDayRangeTimestamps(fromDate, toDate);

    // requireRole を通ったあとにだけ service role のクライアントを作る (認可の前に作ると権限昇格になる)
    const supabase = getSupabaseAdmin();
    const { data: summary, error } = await supabase.rpc(
      LLM_USAGE_SUMMARY_RPC,
      llmUsageSummaryRpcArgs({ fromTimestamp, toTimestampExclusive, model, functionName, provider }),
    );

    // 失敗の記録に付ける検索条件
    const searchContext = { period, from: fromDate, to: toDate, model, function: functionName, provider };

    if (error) {
      // postgrest-js の error は Error ではない素のオブジェクトで、そのまま渡すと app_logs.error_message が
      // '[object Object]' になる。recordAdminAudit と同じく message を持つ Error に包んで渡す
      logger.withUser(user.id).error('LLM 使用量の集計に失敗', new Error(error.message), {
        pg_code: error.code,
        ...searchContext,
      });
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: 'LLM 使用量の取得に失敗しました' } },
        { status: 500 },
      );
    }

    // 応答の形が想定と違うときは 500 にして記録する (黙って 0 件として扱うと、異常のバナーが静かに消える)
    const parsedSummary = LlmUsageSummaryRpcSchema.safeParse(summary);
    if (!parsedSummary.success) {
      logger.withUser(user.id).error('LLM 使用量の集計の応答の形が想定と違う', new Error(parsedSummary.error.message), searchContext);
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: 'LLM 使用量の取得に失敗しました' } },
        { status: 500 },
      );
    }

    return NextResponse.json({
      data: toLlmUsageResponseData(parsedSummary.data, { from: fromDate, to: toDate }),
    });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    // 想定外の例外は内容を記録し、画面には中身を出さない
    logger.error('LLM 使用量 API で予期しないエラー', err);
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました' } }, { status: 500 });
  }
}

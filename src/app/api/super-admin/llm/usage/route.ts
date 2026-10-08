/**
 * GET /api/super-admin/llm/usage  — LLM 使用量ダッシュボード
 * operator/02-api-spec.md §8 + operator/06-ai-llm.md §4 準拠
 *
 * llm_usage_logs の実際の列は input_tokens / output_tokens / total_tokens / estimated_cost_usd。
 * 以前は存在しない prompt_tokens / completion_tokens / cost_usd を select していたため、
 * PostgREST が 42703 で失敗し、この API は常に 500 になっていた (#1306)。
 * 画面が読むレスポンスの項目名 (cost_usd など) は変えず、値は estimated_cost_usd から作る。
 * 列の有無は tests/integration/security/select-columns-exist.test.ts で本番スキーマと突き合わせる。
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { LLMUsageQuerySchema } from '@/lib/super-admin/llm-schemas';
import type { Tables } from '@/types/database.types';

type LlmUsageRow = Pick<
  Tables<'llm_usage_logs'>,
  'model' | 'function_name' | 'estimated_cost_usd' | 'total_tokens' | 'user_id' | 'created_at'
>;

/** 集計に使う行数の上限 */
const MAX_ROWS = 5000;

export async function GET(request: NextRequest) {
  const logger = createLogger('GET /api/super-admin/llm/usage', generateRequestId());
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();
    const { searchParams } = new URL(request.url);

    const parsed = LLMUsageQuerySchema.safeParse(Object.fromEntries(searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }

    const { period, from, to, model, function: functionName, provider } = parsed.data;

    // 期間の計算
    let fromDate: string;
    const toDate = to ?? new Date().toISOString().slice(0, 10);
    if (period === 'custom' && from) {
      fromDate = from;
    } else {
      const days = period === '1d' ? 1 : period === '7d' ? 7 : 30;
      const d = new Date();
      d.setDate(d.getDate() - days);
      fromDate = d.toISOString().slice(0, 10);
    }

    let query = supabase
      .from('llm_usage_logs')
      .select('model, function_name, estimated_cost_usd, total_tokens, user_id, created_at')
      // Edge Function は LLM 呼び出しごとの行に加えて、1 回の実行ごとの合計行 (is_summary = true, model = 'mixed') を
      // 入れる。合計行まで足すとトークン・コスト・リクエスト数が二重に数えられるため、呼び出しごとの行だけを集計する。
      .eq('is_summary', false)
      .gte('created_at', fromDate)
      .lte('created_at', toDate + 'T23:59:59Z');

    if (model) query = query.eq('model', model);
    if (functionName) query = query.eq('function_name', functionName);
    // プロバイダー別の画面 (/super-admin/llm/[provider]) が渡す。llm_usage_logs.provider には openai / xai が入る
    if (provider) query = query.eq('provider', provider);

    const { data: logs, error } = await query.limit(MAX_ROWS);

    if (error) {
      logger.withUser(user.id).error('LLM 使用量ログの取得に失敗', error, {
        pg_code: error.code,
        period,
        from: fromDate,
        to: toDate,
        model,
        function: functionName,
        provider,
      });
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: 'LLM 使用量の取得に失敗しました' } },
        { status: 500 },
      );
    }

    const rows = (logs ?? []) as LlmUsageRow[];
    // 単価表に無いモデル (grok など) は estimated_cost_usd が null なので、コストは 0 として足す
    const costOf = (r: LlmUsageRow) => r.estimated_cost_usd ?? 0;
    const tokensOf = (r: LlmUsageRow) => r.total_tokens ?? 0;

    // 集計
    const totalCostUsd = rows.reduce((s, r) => s + costOf(r), 0);
    const JPY_RATE = 152;

    // モデル別集計
    const modelMap = new Map<string, { requests: number; tokens: number; cost_usd: number }>();
    for (const r of rows) {
      const m = r.model ?? 'unknown';
      const cur = modelMap.get(m) ?? { requests: 0, tokens: 0, cost_usd: 0 };
      modelMap.set(m, {
        requests: cur.requests + 1,
        tokens: cur.tokens + tokensOf(r),
        cost_usd: cur.cost_usd + costOf(r),
      });
    }

    // 機能別集計
    const fnMap = new Map<string, { requests: number; cost_usd: number }>();
    for (const r of rows) {
      const fn = r.function_name ?? 'unknown';
      const cur = fnMap.get(fn) ?? { requests: 0, cost_usd: 0 };
      fnMap.set(fn, { requests: cur.requests + 1, cost_usd: cur.cost_usd + costOf(r) });
    }

    // ユーザー別集計 (Top 50)
    const userMap = new Map<string, { requests: number; cost_usd: number }>();
    for (const r of rows) {
      const uid = r.user_id ?? 'unknown';
      const cur = userMap.get(uid) ?? { requests: 0, cost_usd: 0 };
      userMap.set(uid, { requests: cur.requests + 1, cost_usd: cur.cost_usd + costOf(r) });
    }
    const topUsers = Array.from(userMap.entries())
      .sort(([, a], [, b]) => b.requests - a.requests)
      .slice(0, 50)
      .map(([user_id, stats]) => ({
        user_id,
        email: null, // 別途 join が必要 (パフォーマンス上 omit)
        requests: stats.requests,
        cost_usd: Math.round(stats.cost_usd * 100000) / 100000,
        is_anomaly: stats.requests > 5000,
      }));

    // 日次時系列
    const dateMap = new Map<string, { cost_usd: number; requests: number }>();
    for (const r of rows) {
      // created_at は期間の条件で絞っているので null の行は来ないが、列の定義上は null を取りうる
      const date = (r.created_at ?? '').slice(0, 10);
      if (!date) continue;
      const cur = dateMap.get(date) ?? { cost_usd: 0, requests: 0 };
      dateMap.set(date, { cost_usd: cur.cost_usd + costOf(r), requests: cur.requests + 1 });
    }

    return NextResponse.json({
      data: {
        total_cost_usd: Math.round(totalCostUsd * 100) / 100,
        total_cost_jpy: Math.round(totalCostUsd * JPY_RATE),
        total_requests: rows.length,
        total_tokens: rows.reduce((s, r) => s + tokensOf(r), 0),
        by_model: Array.from(modelMap.entries()).map(([model, stats]) => ({ model, provider: getProvider(model), ...stats })),
        by_function: Array.from(fnMap.entries()).map(([function_name, stats]) => ({ function: function_name, ...stats })),
        top_users: topUsers,
        timeseries: Array.from(dateMap.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, stats]) => ({ date, ...stats })),
        anomalies: topUsers.filter((u) => u.is_anomaly),
        period: { from: fromDate, to: toDate },
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    // 想定外の例外は内容を記録し、画面には中身を出さない
    logger.error('LLM 使用量 API で予期しないエラー', err);
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました' } }, { status: 500 });
  }
}

function getProvider(model: string): string {
  if (model.startsWith('grok')) return 'xai';
  if (model.startsWith('gemini') || model.startsWith('imagen')) return 'gemini';
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt') || model.startsWith('o1')) return 'openai';
  return 'unknown';
}

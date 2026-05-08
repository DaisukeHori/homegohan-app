/**
 * GET /api/super-admin/llm/usage  — LLM 使用量ダッシュボード
 * operator/02-api-spec.md §8 + operator/06-ai-llm.md §4 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { LLMUsageQuerySchema } from '@/lib/super-admin/llm-schemas';

export async function GET(request: NextRequest) {
  try {
    await requireRole(['super_admin']);
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
      .select('model, function_name, cost_usd, prompt_tokens, completion_tokens, total_tokens, user_id, created_at')
      .gte('created_at', fromDate)
      .lte('created_at', toDate + 'T23:59:59Z');

    if (model) query = query.eq('model', model);
    if (functionName) query = query.eq('function_name', functionName);

    const { data: logs, error } = await query.limit(5000);

    if (error) {
      return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: error.message } }, { status: 500 });
    }

    const rows = logs ?? [];

    // 集計
    const totalCostUsd = rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
    const JPY_RATE = 152;

    // モデル別集計
    const modelMap = new Map<string, { requests: number; tokens: number; cost_usd: number }>();
    for (const r of rows) {
      const m = r.model ?? 'unknown';
      const cur = modelMap.get(m) ?? { requests: 0, tokens: 0, cost_usd: 0 };
      modelMap.set(m, {
        requests: cur.requests + 1,
        tokens: cur.tokens + (r.total_tokens ?? 0),
        cost_usd: cur.cost_usd + (r.cost_usd ?? 0),
      });
    }

    // 機能別集計
    const fnMap = new Map<string, { requests: number; cost_usd: number }>();
    for (const r of rows) {
      const fn = r.function_name ?? 'unknown';
      const cur = fnMap.get(fn) ?? { requests: 0, cost_usd: 0 };
      fnMap.set(fn, { requests: cur.requests + 1, cost_usd: cur.cost_usd + (r.cost_usd ?? 0) });
    }

    // ユーザー別集計 (Top 50)
    const userMap = new Map<string, { requests: number; cost_usd: number }>();
    for (const r of rows) {
      const uid = r.user_id ?? 'unknown';
      const cur = userMap.get(uid) ?? { requests: 0, cost_usd: 0 };
      userMap.set(uid, { requests: cur.requests + 1, cost_usd: cur.cost_usd + (r.cost_usd ?? 0) });
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
      const date = (r.created_at as string).slice(0, 10);
      const cur = dateMap.get(date) ?? { cost_usd: 0, requests: 0 };
      dateMap.set(date, { cost_usd: cur.cost_usd + (r.cost_usd ?? 0), requests: cur.requests + 1 });
    }

    return NextResponse.json({
      data: {
        total_cost_usd: Math.round(totalCostUsd * 100) / 100,
        total_cost_jpy: Math.round(totalCostUsd * JPY_RATE),
        total_requests: rows.length,
        total_tokens: rows.reduce((s, r) => s + (r.total_tokens ?? 0), 0),
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
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message } }, { status: 500 });
  }
}

function getProvider(model: string): string {
  if (model.startsWith('grok')) return 'xai';
  if (model.startsWith('gemini') || model.startsWith('imagen')) return 'gemini';
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt') || model.startsWith('o1')) return 'openai';
  return 'unknown';
}

/**
 * GET /api/super-admin/experiments/[id]/results  — 実験結果集計
 * operator/02-api-spec.md §15 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';

type Params = { params: { id: string } };

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireRole(['super_admin']);
    const supabase = await createClient();

    // 実験の存在確認
    const { data: experiment, error: expError } = await supabase
      .from('experiments')
      .select('id, key, name, variants, status, result')
      .eq('id', params.id)
      .single();

    if (expError || !experiment) {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: '実験が見つかりません' } }, { status: 404 });
    }

    // バリアント別の割当数を集計
    const { data: assignments, error: assignError } = await supabase
      .from('experiment_assignments')
      .select('variant_key')
      .eq('experiment_id', params.id);

    if (assignError) {
      return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: assignError.message } }, { status: 500 });
    }

    const variantCounts = new Map<string, number>();
    const variants = (experiment.variants as Array<{ key: string; weight: number }>) ?? [];
    for (const v of variants) {
      variantCounts.set(v.key, 0);
    }
    for (const assignment of (assignments ?? [])) {
      const current = variantCounts.get(assignment.variant_key) ?? 0;
      variantCounts.set(assignment.variant_key, current + 1);
    }

    const total = assignments?.length ?? 0;
    const byVariant = Array.from(variantCounts.entries()).map(([variant_key, count]) => ({
      variant_key,
      assignment_count: count,
      percentage: total > 0 ? Math.round((count / total) * 100 * 10) / 10 : 0,
      conversion_rate: null, // 実際のコンバージョン計算は外部ツール連携が必要
      p_value: null,
      confidence_interval: null,
    }));

    return NextResponse.json({
      data: {
        experiment_id: params.id,
        experiment_key: experiment.key,
        experiment_name: experiment.name,
        status: experiment.status,
        total_assignments: total,
        by_variant: byVariant,
        is_significant: null,
        winner: null,
        stored_result: experiment.result,
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

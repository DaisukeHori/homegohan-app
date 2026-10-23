/**
 * GET /api/super-admin/experiments/[id]/results  — 実験結果集計
 * operator/02-api-spec.md §15 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { authFailureNested } from '@/lib/api/error-responses';
import { internalError } from '@/lib/api/errors';
import { isUuid } from '@/lib/http-params';

type Params = { params: Promise<{ id: string }> };

/** 実験が無い (UUID の形でない id を含む) */
const EXPERIMENT_NOT_FOUND_RESPONSE = { error: { code: 'NOT_FOUND', message: '実験が見つかりません' } } as const;

export async function GET(_request: NextRequest, props: Params) {
  const params = await props.params;
  try {
    await requireRole(['super_admin']);
    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json(EXPERIMENT_NOT_FOUND_RESPONSE, { status: 404 });
    }
    const supabase = await createClient();

    // 実験の存在確認。読めなかったときは 404 にしない (行が無いときだけ 404。一時的な失敗で実験が消えたように見せない。#1917)
    const { data: experiment, error: expError } = await supabase
      .from('experiments')
      .select('id, key, name, variants, status, result')
      .eq('id', params.id)
      .maybeSingle();

    if (expError) {
      return internalError('GET /api/super-admin/experiments/[id]/results', expError, { table: 'experiments' }, { shape: 'nested' });
    }
    if (!experiment) {
      return NextResponse.json(EXPERIMENT_NOT_FOUND_RESPONSE, { status: 404 });
    }

    // バリアント別の割当数を集計
    const { data: assignments, error: assignError } = await supabase
      .from('experiment_assignments')
      .select('variant_key')
      .eq('experiment_id', params.id);

    if (assignError) {
      return internalError('GET /api/super-admin/experiments/[id]/results', assignError, {}, { shape: 'nested' });
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
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError('GET /api/super-admin/experiments/[id]/results', err, {}, { shape: 'nested' });
  }
}

/**
 * GET   /api/super-admin/llm/quotas  — クォータ一覧
 * PATCH /api/super-admin/llm/quotas  — クォータ変更
 * operator/02-api-spec.md §8 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { UpdateLLMQuotaSchema } from '@/lib/super-admin/llm-schemas';

export async function GET() {
  try {
    await requireRole(['super_admin']);

    // デフォルトクォータ設定を返す (per operator/06-ai-llm.md §5.1)
    const defaultQuotas = [
      { plan_key: 'free', daily_limit: 50, monthly_limit: 1000 },
      { plan_key: 'pro', daily_limit: 500, monthly_limit: 10000 },
      { plan_key: 'family_basic', daily_limit: 800, monthly_limit: 20000 },
      { plan_key: 'family_pro', daily_limit: 1500, monthly_limit: 50000 },
      { plan_key: 'org_starter', daily_limit: 200, monthly_limit: 5000 },
      { plan_key: 'org_standard', daily_limit: 500, monthly_limit: 10000 },
      { plan_key: 'org_pro', daily_limit: 1000, monthly_limit: 30000 },
      { plan_key: 'org_enterprise', daily_limit: null, monthly_limit: null },
    ];

    return NextResponse.json({ data: defaultQuotas });
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

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();
    const body = await request.json();

    const parsed = UpdateLLMQuotaSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }

    const { target_type, target_id, daily_limit, monthly_limit, reason } = parsed.data;

    // 監査ログ (LLM クォータ変更は重要操作)
    await supabase.from('admin_audit_logs').insert({
      actor_id: user.id,
      action_type: 'super_admin.llm_quota.override',
      target_type,
      target_id,
      details: { daily_limit, monthly_limit, reason },
      severity: 'warn',
    });

    return NextResponse.json({
      data: {
        target_type,
        target_id,
        daily_limit: daily_limit ?? null,
        monthly_limit: monthly_limit ?? null,
        updated_at: new Date().toISOString(),
        updated_by: user.id,
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

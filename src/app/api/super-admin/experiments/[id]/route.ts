/**
 * GET    /api/super-admin/experiments/[id]  — 実験詳細
 * PATCH  /api/super-admin/experiments/[id]  — 実験更新 (start/stop/cancel)
 * DELETE /api/super-admin/experiments/[id]  — 実験削除
 * operator/02-api-spec.md §15 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { UpdateExperimentSchema } from '@/lib/super-admin/experiments-schemas';

type Params = { params: { id: string } };

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireRole(['super_admin']);
    const supabase = await createClient();

    const { data, error } = await supabase
      .from('experiments')
      .select('*')
      .eq('id', params.id)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: '実験が見つかりません' } }, { status: 404 });
    }

    return NextResponse.json({ data });
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

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();
    const body = await request.json();

    const parsed = UpdateExperimentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }

    const { data, error } = await supabase
      .from('experiments')
      .update(parsed.data)
      .eq('id', params.id)
      .select()
      .single();

    if (error || !data) {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: '実験が見つかりません' } }, { status: 404 });
    }

    // 監査ログ
    await supabase.from('admin_audit_logs').insert({
      actor_id: user.id,
      action_type: 'super_admin.plan.update',
      target_type: 'experiment',
      target_id: params.id,
      details: { changes: parsed.data },
      severity: parsed.data.status === 'cancelled' ? 'warn' : 'info',
    });

    return NextResponse.json({ data });
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

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();

    // running 状態の実験は削除不可
    const { data: existing } = await supabase
      .from('experiments')
      .select('status, key, name')
      .eq('id', params.id)
      .single();

    if (!existing) {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: '実験が見つかりません' } }, { status: 404 });
    }

    if (existing.status === 'running') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '実行中の実験は削除できません。先にキャンセルしてください。' } },
        { status: 422 },
      );
    }

    // experiment_assignments を先に削除
    await supabase.from('experiment_assignments').delete().eq('experiment_id', params.id);

    const { error } = await supabase.from('experiments').delete().eq('id', params.id);
    if (error) {
      return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: error.message } }, { status: 500 });
    }

    // 監査ログ
    await supabase.from('admin_audit_logs').insert({
      actor_id: user.id,
      action_type: 'super_admin.plan.update',
      target_type: 'experiment',
      target_id: params.id,
      details: { key: existing.key, name: existing.name, action: 'delete' },
      severity: 'warn',
    });

    return NextResponse.json({ data: { id: params.id, deleted: true } });
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

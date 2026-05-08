/**
 * GET    /api/super-admin/exports/[id]  — エクスポートステータス確認
 * DELETE /api/super-admin/exports/[id]  — エクスポートキャンセル
 * operator/02-api-spec.md §16 準拠
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

    const { data, error } = await supabase
      .from('gdpr_deletion_requests')
      .select('*')
      .eq('id', params.id)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'エクスポートが見つかりません' } }, { status: 404 });
    }

    return NextResponse.json({
      data: {
        id: data.id,
        export_type: data.deletion_type ?? 'user_data',
        format: (data.request_details as { format?: string } | null)?.format ?? 'csv',
        status: data.status ?? 'pending',
        requested_by: data.user_id,
        created_at: data.created_at,
        file_url: null,
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

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();

    const { data: existing } = await supabase
      .from('gdpr_deletion_requests')
      .select('status')
      .eq('id', params.id)
      .single();

    if (!existing) {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'エクスポートが見つかりません' } }, { status: 404 });
    }

    if (existing.status === 'completed') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '完了済みのエクスポートはキャンセルできません' } },
        { status: 422 },
      );
    }

    await supabase
      .from('gdpr_deletion_requests')
      .update({ status: 'cancelled' })
      .eq('id', params.id);

    // 監査ログ
    await supabase.from('admin_audit_logs').insert({
      actor_id: user.id,
      action_type: 'admin.export.request',
      target_type: 'export',
      target_id: params.id,
      details: { action: 'cancel' },
      severity: 'info',
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

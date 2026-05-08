/**
 * GET    /api/super-admin/feature-packages/[id] — 機能パッケージ詳細
 * PATCH  /api/super-admin/feature-packages/[id] — 機能パッケージ更新
 * DELETE /api/super-admin/feature-packages/[id] — 機能パッケージ削除
 *
 * operator/01-data-model.md §3.3 準拠
 * 権限: super_admin のみ
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { FeaturePackageUpdateSchema } from '@/lib/super-admin/feature-packages-schemas';

type RouteContext = { params: { id: string } };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    await requireRole(['super_admin']);
    const supabase = createClient();

    const { data: pkg, error } = await supabase
      .from('feature_packages')
      .select('*')
      .eq('id', params.id)
      .single();

    if (error || !pkg) {
      return NextResponse.json(
        { error: { code: 'OP_PACKAGE_NOT_FOUND', message: '機能パッケージが見つかりません' } },
        { status: 404 }
      );
    }

    return NextResponse.json({ data: pkg });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/feature-packages/[id] GET]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = createClient();

    const body = await request.json();
    const parseResult = FeaturePackageUpdateSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'OP_INVALID_INPUT', message: parseResult.error.message, details: parseResult.error.issues } },
        { status: 400 }
      );
    }

    const input = parseResult.data;
    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (input.display_name !== undefined) updateData.display_name = input.display_name;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.feature_flags !== undefined) updateData.feature_flags = input.feature_flags;
    if (input.display_order !== undefined) updateData.display_order = input.display_order;
    if (input.status !== undefined) updateData.status = input.status;

    const { data: updated, error } = await supabase
      .from('feature_packages')
      .update(updateData)
      .eq('id', params.id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json(
          { error: { code: 'OP_PACKAGE_NOT_FOUND', message: '機能パッケージが見つかりません' } },
          { status: 404 }
        );
      }
      console.error('[super-admin/feature-packages/[id] PATCH]', error);
      return NextResponse.json(
        { error: { code: 'OP_DB_ERROR', message: error.message } },
        { status: 500 }
      );
    }

    // 監査ログ記録
    try {
      await supabase.from('admin_audit_logs').insert({
        actor_id: user.id,
        target_id: params.id,
        target_type: 'feature_package',
        action_type: 'update_feature_package',
        details: { changes: updateData },
        severity: 'info',
        ip_address: request.headers.get('x-forwarded-for'),
      });
    } catch (auditErr) {
      console.warn('[super-admin/feature-packages/[id] PATCH] audit log failed (graceful):', auditErr);
    }

    return NextResponse.json({ data: updated });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/feature-packages/[id] PATCH]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = createClient();

    const { data: existing, error: fetchErr } = await supabase
      .from('feature_packages')
      .select('id, package_key, status')
      .eq('id', params.id)
      .single();

    if (fetchErr || !existing) {
      return NextResponse.json(
        { error: { code: 'OP_PACKAGE_NOT_FOUND', message: '機能パッケージが見つかりません' } },
        { status: 404 }
      );
    }

    const { error: deleteErr } = await supabase
      .from('feature_packages')
      .delete()
      .eq('id', params.id);

    if (deleteErr) {
      // FK 制約違反 (subscription_plans.feature_packages 配列に含まれている場合は削除不可)
      if (deleteErr.code === '23503') {
        return NextResponse.json(
          { error: { code: 'OP_PACKAGE_IN_USE', message: 'プランで使用中の機能パッケージは削除できません' } },
          { status: 409 }
        );
      }
      console.error('[super-admin/feature-packages/[id] DELETE]', deleteErr);
      return NextResponse.json(
        { error: { code: 'OP_DB_ERROR', message: deleteErr.message } },
        { status: 500 }
      );
    }

    // 監査ログ記録
    try {
      await supabase.from('admin_audit_logs').insert({
        actor_id: user.id,
        target_id: params.id,
        target_type: 'feature_package',
        action_type: 'delete_feature_package',
        details: { package_key: existing.package_key },
        severity: 'warn',
        ip_address: request.headers.get('x-forwarded-for'),
      });
    } catch (auditErr) {
      console.warn('[super-admin/feature-packages/[id] DELETE] audit log failed (graceful):', auditErr);
    }

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/feature-packages/[id] DELETE]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}

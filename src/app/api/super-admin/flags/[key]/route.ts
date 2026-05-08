/**
 * PATCH  /api/super-admin/flags/[key]  — 機能フラグ更新
 * DELETE /api/super-admin/flags/[key]  — 機能フラグ削除
 * operator/02-api-spec.md §7 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { UpdateFeatureFlagSchema } from '@/lib/super-admin/flags-schemas';

type Params = { params: { key: string } };

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();
    const flagKey = params.key;
    const body = await request.json();

    const parsed = UpdateFeatureFlagSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }

    // 監査ログ
    await supabase.from('admin_audit_logs').insert({
      actor_id: user.id,
      action_type: 'super_admin.feature_flag.toggle',
      target_type: 'feature_flag',
      details: { key: flagKey, changes: parsed.data },
      severity: 'info',
    });

    return NextResponse.json({
      data: { key: flagKey, ...parsed.data, updated_at: new Date().toISOString() },
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
    const flagKey = params.key;

    // feature_packages からフラグキーが使用中か確認
    const { data: pkgs } = await supabase
      .from('feature_packages')
      .select('id, package_key, feature_flags')
      .contains('feature_flags', [flagKey]);

    if (pkgs && pkgs.length > 0) {
      return NextResponse.json(
        {
          error: {
            code: 'OP_FEATURE_FLAG_IN_USE',
            message: `このフラグは ${pkgs.map((p) => p.package_key).join(', ')} で使用中のため削除できません`,
          },
        },
        { status: 409 },
      );
    }

    // 監査ログ
    await supabase.from('admin_audit_logs').insert({
      actor_id: user.id,
      action_type: 'super_admin.feature_flag.toggle',
      target_type: 'feature_flag',
      details: { key: flagKey, action: 'delete' },
      severity: 'warn',
    });

    return NextResponse.json({ data: { key: flagKey, deleted: true } });
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

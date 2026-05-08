/**
 * GET  /api/super-admin/flags  — 機能フラグ一覧
 * POST /api/super-admin/flags  — 機能フラグ作成
 * operator/02-api-spec.md §7 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { CreateFeatureFlagSchema } from '@/lib/super-admin/flags-schemas';

export async function GET() {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();

    const { data, error } = await supabase
      .from('feature_packages')
      .select('id, package_key, display_name, feature_flags, status, display_order, created_at, updated_at')
      .eq('status', 'active')
      .order('display_order', { ascending: true });

    if (error) {
      return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: error.message } }, { status: 500 });
    }

    // feature_packages の feature_flags 配列から flags を正規化して返す
    const flagMap = new Map<string, {
      key: string;
      description: string;
      enabled: boolean;
      rollout_strategy: Record<string, unknown> | null;
      constraints: Record<string, unknown> | null;
      active_user_count: number;
      updated_at: string;
    }>();

    for (const pkg of (data ?? [])) {
      for (const flagKey of (pkg.feature_flags ?? [])) {
        if (!flagMap.has(flagKey)) {
          flagMap.set(flagKey, {
            key: flagKey,
            description: `${pkg.display_name} に含まれるフラグ`,
            enabled: true,
            rollout_strategy: null,
            constraints: null,
            active_user_count: 0,
            updated_at: pkg.updated_at,
          });
        }
      }
    }

    return NextResponse.json({
      data: Array.from(flagMap.values()),
      meta: { total: flagMap.size, page: 1, per_page: flagMap.size },
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

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();
    const body = await request.json();

    const parsed = CreateFeatureFlagSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }

    const { key, description, enabled, rollout_strategy, constraints } = parsed.data;

    // feature_packages に新しいフラグキーを追加 (basic パッケージへ append)
    const { data: basicPkg, error: pkgError } = await supabase
      .from('feature_packages')
      .select('id, feature_flags')
      .eq('package_key', 'basic')
      .single();

    if (pkgError || !basicPkg) {
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: '機能パッケージが見つかりません' } },
        { status: 500 },
      );
    }

    const currentFlags: string[] = basicPkg.feature_flags ?? [];
    if (currentFlags.includes(key)) {
      return NextResponse.json(
        { error: { code: 'OP_FEATURE_FLAG_IN_USE', message: 'このキーは既に使用されています' } },
        { status: 409 },
      );
    }

    const { error: updateError } = await supabase
      .from('feature_packages')
      .update({
        feature_flags: [...currentFlags, key],
        updated_at: new Date().toISOString(),
      })
      .eq('id', basicPkg.id);

    if (updateError) {
      return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: updateError.message } }, { status: 500 });
    }

    // 監査ログ
    await supabase.from('admin_audit_logs').insert({
      actor_id: user.id,
      action_type: 'super_admin.feature_flag.toggle',
      target_type: 'feature_flag',
      details: { key, description, enabled, rollout_strategy, constraints, action: 'create' },
      severity: 'info',
    });

    return NextResponse.json({
      data: { key, description, enabled, rollout_strategy, constraints, created_at: new Date().toISOString() },
    }, { status: 201 });
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

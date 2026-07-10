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

    // #1029: feature_flags テーブルから実データを取得する (以前は feature_packages.feature_flags
    // 配列から flags を合成し enabled:true をハードコードして返していた no-op 実装だった)
    const { data, error } = await supabase
      .from('feature_flags')
      .select('key, description, enabled, rollout_strategy, constraints, updated_at')
      .order('created_at', { ascending: true });

    if (error) {
      return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: error.message } }, { status: 500 });
    }

    const flags = (data ?? []).map((flag) => ({
      key: flag.key,
      description: flag.description ?? '',
      enabled: flag.enabled,
      rollout_strategy: flag.rollout_strategy,
      constraints: flag.constraints,
      // TODO: 実ユーザー数の算出はスコープ外 (#1029)。rollout/constraints を
      // user_profiles に対して実際に集計する仕組みは別 Issue で対応する。
      active_user_count: 0,
      updated_at: flag.updated_at,
    }));

    return NextResponse.json({
      data: flags,
      meta: { total: flags.length, page: 1, per_page: flags.length },
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

    // #1029: feature_flags テーブルへ実体を作成する (以前は feature_packages.feature_flags
    // 配列にキーを append するだけで、enabled/rollout_strategy/constraints を保持する
    // 場所が無かった)
    const { data: created, error: insertError } = await supabase
      .from('feature_flags')
      .insert({
        key,
        description: description ?? null,
        enabled,
        rollout_strategy: rollout_strategy ?? null,
        constraints: constraints ?? null,
        created_by: user.id,
      })
      .select('key, description, enabled, rollout_strategy, constraints, created_at')
      .single();

    if (insertError) {
      if (insertError.code === '23505') {
        return NextResponse.json(
          { error: { code: 'OP_FEATURE_FLAG_IN_USE', message: 'このキーは既に使用されています' } },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: insertError.message } }, { status: 500 });
    }

    // feature_packages に新しいフラグキーを追加 (basic パッケージへ append)。
    // feature_packages.feature_flags は「パッケージが含むフラグキー一覧」であり、
    // DELETE の in-use チェック (このキーをどのパッケージが使用中か) に用いる。
    // 'basic' パッケージが存在しない環境でもフラグ本体の作成自体は成立させるため、
    // ここでの失敗は致命的エラーにしない (best-effort)。
    const { data: basicPkg } = await supabase
      .from('feature_packages')
      .select('id, feature_flags')
      .eq('package_key', 'basic')
      .single();

    if (basicPkg) {
      const currentFlags: string[] = basicPkg.feature_flags ?? [];
      if (!currentFlags.includes(key)) {
        await supabase
          .from('feature_packages')
          .update({ feature_flags: [...currentFlags, key], updated_at: new Date().toISOString() })
          .eq('id', basicPkg.id);
      }
    }

    // 監査ログ
    await supabase.from('admin_audit_logs').insert({
      actor_id: user.id,
      action_type: 'super_admin.feature_flag.toggle',
      target_type: 'feature_flag',
      details: { key, description, enabled, rollout_strategy, constraints, action: 'create' },
      severity: 'info',
    });

    return NextResponse.json({ data: created }, { status: 201 });
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

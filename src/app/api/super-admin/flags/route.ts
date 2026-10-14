/**
 * GET  /api/super-admin/flags  — 機能フラグ一覧
 * POST /api/super-admin/flags  — 機能フラグ作成
 * operator/02-api-spec.md §7 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createLogger } from '@/lib/db-logger';
import { invalidateFeatureFlag } from '@/lib/feature-flags';
import { CreateFeatureFlagSchema } from '@/lib/super-admin/flags-schemas';
import { countActiveUsersForFlags } from '@/lib/super-admin/flag-active-users';
import { internalError } from '@/lib/api/errors';

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
      return internalError('GET /api/super-admin/flags', error, { userId: user.id }, { shape: 'nested' });
    }

    // #1148: active_user_count は、アプリの判定 (evaluateFlag) を全ユーザーに実行して数える。
    // requireRole(['super_admin']) を通したあとだけ、サービスロールで user_profiles の判定に要る列を読む
    // (RLS で本人の行しか見えないため)。返すのは人数だけで、ユーザーの情報は返さない。
    // 数えられなかったとき (ユーザーが多すぎる・読み出しの失敗) は null にして、フラグの一覧そのものは返す
    let activeUserCounts = new Map<string, number | null>();
    try {
      activeUserCounts = await countActiveUsersForFlags(getSupabaseAdmin(), data ?? []);
    } catch (countError) {
      createLogger('api/super-admin/flags').withUser(user.id).error(
        'フラグごとの対象ユーザー数の集計に失敗しました',
        countError,
      );
    }

    const flags = (data ?? []).map((flag) => ({
      key: flag.key,
      description: flag.description ?? '',
      enabled: flag.enabled,
      rollout_strategy: flag.rollout_strategy,
      constraints: flag.constraints,
      active_user_count: activeUserCounts.get(flag.key) ?? null,
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
    return internalError('GET /api/super-admin/flags', err, {}, { shape: 'nested' });
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
      return internalError('POST /api/super-admin/flags', insertError, { userId: user.id }, { shape: 'nested' });
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

    // #1148: この API を処理したインスタンスの、API route 側が覚えている「行が無い」状態を忘れる。
    // 他のインスタンスとミドルウェア (Edge。メモリは別) には、最大 30 秒で反映される
    invalidateFeatureFlag(key);

    return NextResponse.json({ data: created }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    return internalError('POST /api/super-admin/flags', err, {}, { shape: 'nested' });
  }
}

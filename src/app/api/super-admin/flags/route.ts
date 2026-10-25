/**
 * GET  /api/super-admin/flags  — 機能フラグ一覧
 * POST /api/super-admin/flags  — 機能フラグ作成
 * operator/02-api-spec.md §7 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { authFailureNested } from '@/lib/api/error-responses';
import { createLogger } from '@/lib/db-logger';
import { invalidateFeatureFlag } from '@/lib/feature-flags';
import { CreateFeatureFlagSchema } from '@/lib/super-admin/flags-schemas';
import { countActiveUsersForFlags } from '@/lib/super-admin/flag-active-users';
import { internalError } from '@/lib/api/errors';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { readJsonBody, SUPER_ADMIN_INVALID_JSON_BODY_MESSAGE } from '@/lib/super-admin/validation-errors';

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
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError('GET /api/super-admin/flags', err, {}, { shape: 'nested' });
  }
}

export async function POST(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();
    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      // #1654: 本文が JSON として読めないときは 400 (外側の catch の 500 に落とさない)。コードはこの route の他の 400 と同じ VALIDATION_ERROR
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: SUPER_ADMIN_INVALID_JSON_BODY_MESSAGE } },
        { status: 400 },
      );
    }
    const body = bodyResult.body;

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
    // 書き込みは service_role だけ (requireRole を通したあと。運営の直接の書き込みを塞いだ。#1917 の続き)
    const { data: created, error: insertError } = await getSupabaseAdmin()
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
        // 書き込みは service_role だけ (requireRole を通したあと。運営の直接の書き込みを塞いだ。#1917 の続き)
        await getSupabaseAdmin()
          .from('feature_packages')
          .update({ feature_flags: [...currentFlags, key], updated_at: new Date().toISOString() })
          .eq('id', basicPkg.id);
      }
    }

    // 監査ログ
    await recordAdminAudit({
      supabase,
      actorId: user.id,
      actionType: 'super_admin.feature_flag.toggle',
      targetType: 'feature_flag',
      details: { key, description, enabled, rollout_strategy, constraints, action: 'create' },
      severity: 'info',
      request,
      routeName: 'api/super-admin/flags POST',
    });

    // #1148: この API を処理したインスタンスの、API route 側が覚えている「行が無い」状態を忘れる。
    // 他のインスタンスと proxy (src/proxy.ts。API route とメモリを共有するとは限らない) には、最大 30 秒で反映される
    invalidateFeatureFlag(key);

    return NextResponse.json({ data: created }, { status: 201 });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError('POST /api/super-admin/flags', err, {}, { shape: 'nested' });
  }
}

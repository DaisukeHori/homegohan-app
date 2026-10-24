/**
 * PATCH  /api/super-admin/flags/[key]  — 機能フラグ更新
 * DELETE /api/super-admin/flags/[key]  — 機能フラグ削除
 * operator/02-api-spec.md §7 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { authFailureNested } from '@/lib/api/error-responses';
import { invalidateFeatureFlag } from '@/lib/feature-flags';
import { UpdateFeatureFlagSchema } from '@/lib/super-admin/flags-schemas';
import { internalError } from '@/lib/api/errors';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { readJsonBody, SUPER_ADMIN_INVALID_JSON_BODY_MESSAGE } from '@/lib/super-admin/validation-errors';

type Params = { params: Promise<{ key: string }> };

export async function PATCH(request: NextRequest, props: Params) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();
    const flagKey = params.key;
    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      // #1654: 本文が JSON として読めないときは 400 (外側の catch の 500 に落とさない)。コードはこの route の他の 400 と同じ VALIDATION_ERROR
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: SUPER_ADMIN_INVALID_JSON_BODY_MESSAGE } },
        { status: 400 },
      );
    }
    const body = bodyResult.body;

    const parsed = UpdateFeatureFlagSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }

    // #1029: feature_flags テーブルを実 UPDATE する (以前は監査ログを INSERT するだけで
    // enabled/rollout_strategy/constraints を永続化していなかった)
    const updateData: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };

    const { data: updated, error } = await supabase
      .from('feature_flags')
      .update(updateData)
      .eq('key', flagKey)
      .select('key, description, enabled, rollout_strategy, constraints, updated_at')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json(
          { error: { code: 'OP_FEATURE_FLAG_NOT_FOUND', message: '指定されたフラグが見つかりません' } },
          { status: 404 },
        );
      }
      return internalError('PATCH /api/super-admin/flags/[key]', error, { userId: user.id }, { shape: 'nested' });
    }

    // 監査ログ
    await recordAdminAudit({
      supabase,
      actorId: user.id,
      actionType: 'super_admin.feature_flag.toggle',
      targetType: 'feature_flag',
      details: { key: flagKey, changes: parsed.data },
      severity: 'info',
      request,
      routeName: 'api/super-admin/flags/[key] PATCH',
    });

    // #1148: この API を処理したインスタンスの、API route 側のフラグのメモリを新しくする。
    // 他のインスタンスと proxy (src/proxy.ts。API route とメモリを共有するとは限らない) には、最大 30 秒で反映される
    invalidateFeatureFlag(flagKey);

    return NextResponse.json({ data: updated });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError('PATCH /api/super-admin/flags/[key]', err, {}, { shape: 'nested' });
  }
}

export async function DELETE(request: NextRequest, props: Params) {
  const params = await props.params;
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
            // パッケージのキー (英字) は括弧に入れて添える (#1917 の続き)
            message: `このフラグは次の機能のパッケージで使用中のため削除できません (${pkgs.map((p) => p.package_key).join(', ')})`,
          },
        },
        { status: 409 },
      );
    }

    // #1029: feature_flags テーブルから実 DELETE する (以前は監査ログを INSERT するだけで
    // 実データを一切削除していなかった)。未登録キー (feature_flags に行が無い) の DELETE は
    // 0 行 affected でもエラーにせず成功として扱う (既存の orphan キー削除フローと整合)。
    const { error: deleteError } = await supabase
      .from('feature_flags')
      .delete()
      .eq('key', flagKey);

    if (deleteError) {
      return internalError('DELETE /api/super-admin/flags/[key]', deleteError, { userId: user.id }, { shape: 'nested' });
    }

    // 監査ログ
    await recordAdminAudit({
      supabase,
      actorId: user.id,
      actionType: 'super_admin.feature_flag.toggle',
      targetType: 'feature_flag',
      details: { key: flagKey, action: 'delete' },
      severity: 'warn',
      request,
      routeName: 'api/super-admin/flags/[key] DELETE',
    });

    // #1148: この API を処理したインスタンスの、API route 側のフラグのメモリを新しくする。
    // 他のインスタンスと proxy (src/proxy.ts。API route とメモリを共有するとは限らない) には、最大 30 秒で反映される
    invalidateFeatureFlag(flagKey);

    return NextResponse.json({ data: { key: flagKey, deleted: true } });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError('DELETE /api/super-admin/flags/[key]', err, {}, { shape: 'nested' });
  }
}

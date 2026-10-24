/**
 * GET    /api/super-admin/feature-packages/[id] — 機能パッケージ詳細
 * PATCH  /api/super-admin/feature-packages/[id] — 機能パッケージ更新
 * DELETE /api/super-admin/feature-packages/[id] — 機能パッケージ削除
 *
 * operator/01-data-model.md §3.3 準拠
 * 権限: super_admin のみ
 *
 * 読み込みの DB の失敗 (#1917): GET・DELETE の読み込みは、DB の失敗を 500 にし、行が無いときだけ 404 にする
 * (一時的な失敗で機能パッケージが消えたように見せない)。UUID の形でない id は DB に渡さず 404。
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { FeaturePackageUpdateSchema } from '@/lib/super-admin/feature-packages-schemas';
import { internalError } from '@/lib/api/errors';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { invalidInputResponse, invalidJsonBodyResponse, readJsonBody } from '@/lib/super-admin/validation-errors';
import { isUuid } from '@/lib/http-params';

type RouteContext = { params: Promise<{ id: string }> };

/** 機能パッケージが無い (UUID の形でない id を含む) */
const PACKAGE_NOT_FOUND_RESPONSE = { error: { code: 'OP_PACKAGE_NOT_FOUND', message: '機能パッケージが見つかりません' } } as const;

export async function GET(_request: NextRequest, props: RouteContext) {
  const params = await props.params;
  try {
    await requireRole(['super_admin']);
    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json(PACKAGE_NOT_FOUND_RESPONSE, { status: 404 });
    }
    const supabase = await createClient();

    const { data: pkg, error } = await supabase
      .from('feature_packages')
      .select('*')
      .eq('id', params.id)
      .maybeSingle();

    // 読めなかったときは 404 にしない (行が無いときだけ 404。一時的な失敗で消えたように見せない。#1917)
    if (error) {
      return internalError('GET /api/super-admin/feature-packages/[id]', error, { table: 'feature_packages' }, { shape: 'nested' });
    }
    if (!pkg) {
      return NextResponse.json(PACKAGE_NOT_FOUND_RESPONSE, { status: 404 });
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

export async function PATCH(request: NextRequest, props: RouteContext) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();

    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      // #1654: 本文が JSON として読めないときは 400 OP_INVALID_INPUT (外側の catch の 500 に落とさない)
      return invalidJsonBodyResponse();
    }
    const body = bodyResult.body;
    const parseResult = FeaturePackageUpdateSchema.safeParse(body);

    if (!parseResult.success) {
      return invalidInputResponse(parseResult.error.issues);
    }

    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json(PACKAGE_NOT_FOUND_RESPONSE, { status: 404 });
    }

    const input = parseResult.data;
    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (input.display_name !== undefined) updateData.display_name = input.display_name;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.feature_flags !== undefined) updateData.feature_flags = input.feature_flags;
    if (input.display_order !== undefined) updateData.display_order = input.display_order;
    if (input.status !== undefined) updateData.status = input.status;

    // 書き込みは service_role だけ (requireRole を通したあと。運営の直接の書き込みを塞いだ。#1917 の続き)
    const { data: updated, error } = await getSupabaseAdmin()
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
      return internalError('PATCH /api/super-admin/feature-packages/[id]', error, { userId: user.id }, { shape: 'nested' });
    }

    // 監査ログ記録
    await recordAdminAudit({
      supabase,
      actorId: user.id,
      targetId: params.id,
      targetType: 'feature_package',
      actionType: 'update_feature_package',
      details: { changes: updateData },
      severity: 'info',
      request,
      routeName: 'api/super-admin/feature-packages/[id] PATCH',
    });

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

export async function DELETE(request: NextRequest, props: RouteContext) {
  const params = await props.params;
  try {
    const user = await requireRole(['super_admin']);
    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json(PACKAGE_NOT_FOUND_RESPONSE, { status: 404 });
    }
    const supabase = await createClient();

    const { data: existing, error: fetchErr } = await supabase
      .from('feature_packages')
      .select('id, package_key, status')
      .eq('id', params.id)
      .maybeSingle();

    // 読めなかったときは 404 にしない (行が無いときだけ 404。一時的な失敗で消えたように見せない。#1917)
    if (fetchErr) {
      return internalError('DELETE /api/super-admin/feature-packages/[id]', fetchErr, { userId: user.id, table: 'feature_packages' }, { shape: 'nested' });
    }
    if (!existing) {
      return NextResponse.json(PACKAGE_NOT_FOUND_RESPONSE, { status: 404 });
    }

    // 書き込みは service_role だけ (requireRole を通したあと。運営の直接の書き込みを塞いだ。#1917 の続き)
    const { error: deleteErr } = await getSupabaseAdmin()
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
      return internalError('DELETE /api/super-admin/feature-packages/[id]', deleteErr, { userId: user.id }, { shape: 'nested' });
    }

    // 監査ログ記録
    await recordAdminAudit({
      supabase,
      actorId: user.id,
      targetId: params.id,
      targetType: 'feature_package',
      actionType: 'delete_feature_package',
      details: { package_key: existing.package_key },
      severity: 'warn',
      request,
      routeName: 'api/super-admin/feature-packages/[id] DELETE',
    });

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

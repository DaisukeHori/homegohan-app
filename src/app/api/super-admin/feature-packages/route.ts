/**
 * GET  /api/super-admin/feature-packages — 機能パッケージ一覧
 * POST /api/super-admin/feature-packages — 機能パッケージ新規作成
 *
 * operator/01-data-model.md §3.3 / operator/02-api-spec.md 準拠
 * 権限: super_admin のみ
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import {
  FeaturePackageCreateSchema,
  FeaturePackagesQuerySchema,
} from '@/lib/super-admin/feature-packages-schemas';
import { internalError } from '@/lib/api/errors';
import { listCountOptions, resolveBeyondLastPage } from '@/lib/api/list-range';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { invalidInputResponse, invalidJsonBodyResponse, invalidQueryResponse, readJsonBody } from '@/lib/super-admin/validation-errors';

/** 一覧の構造化ログの function_name */
const LIST_ROUTE_NAME = 'GET /api/super-admin/feature-packages';

export async function GET(request: NextRequest) {
  try {
    await requireRole(['super_admin']);
    const supabase = await createClient();

    const { searchParams } = request.nextUrl;
    const queryResult = FeaturePackagesQuerySchema.safeParse({
      status: searchParams.get('status') ?? undefined,
      page: searchParams.get('page') ?? undefined,
      per_page: searchParams.get('per_page') ?? undefined,
    });

    if (!queryResult.success) {
      return invalidQueryResponse(queryResult.error.issues);
    }

    const { status, page, per_page } = queryResult.data;
    const offset = (page - 1) * per_page;

    // 一覧と、範囲外のページのときの件数の数え直し (src/lib/api/list-range.ts) は、同じ絞り込み (selectFeaturePackages) から作る
    const selectFeaturePackages = (options: { head?: boolean } = {}) => {
      let query = supabase
        .from('feature_packages')
        .select('*', listCountOptions(options.head));

      if (status) query = query.eq('status', status);

      return query;
    };

    const { data, error, count } = await resolveBeyondLastPage(
      await selectFeaturePackages()
        .order('display_order', { ascending: true })
        .range(offset, offset + per_page - 1),
      () => selectFeaturePackages({ head: true }),
      LIST_ROUTE_NAME,
    );

    if (error) {
      return internalError(LIST_ROUTE_NAME, error, {}, { shape: 'nested' });
    }

    return NextResponse.json({
      data,
      meta: { total: count ?? 0, page, per_page },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/feature-packages GET]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
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
      // #1654: 本文が JSON として読めないときは 400 OP_INVALID_INPUT (外側の catch の 500 に落とさない)
      return invalidJsonBodyResponse();
    }
    const body = bodyResult.body;
    const parseResult = FeaturePackageCreateSchema.safeParse(body);

    if (!parseResult.success) {
      return invalidInputResponse(parseResult.error.issues);
    }

    const input = parseResult.data;

    // 書き込みは service_role だけ (requireRole を通したあと。運営の直接の書き込みを塞いだ。#1917 の続き)
    const { data: pkg, error } = await getSupabaseAdmin()
      .from('feature_packages')
      .insert({
        package_key: input.package_key,
        display_name: input.display_name,
        description: input.description ?? null,
        feature_flags: input.feature_flags,
        display_order: input.display_order ?? 0,
        status: 'active',
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: { code: 'OP_PACKAGE_KEY_DUPLICATE', message: 'パッケージのキー (package_key) は既に存在します' } },
          { status: 409 }
        );
      }
      return internalError('POST /api/super-admin/feature-packages', error, { userId: user.id }, { shape: 'nested' });
    }

    // 監査ログ記録
    await recordAdminAudit({
      supabase,
      actorId: user.id,
      targetId: pkg.id,
      targetType: 'feature_package',
      actionType: 'create_feature_package',
      details: { package_key: input.package_key, display_name: input.display_name },
      severity: 'info',
      request,
      routeName: 'api/super-admin/feature-packages POST',
    });

    return NextResponse.json({ data: pkg }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, { status: 403 });
    }
    console.error('[super-admin/feature-packages POST]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}

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
import { createClient } from '@/lib/supabase/server';
import {
  FeaturePackageCreateSchema,
  FeaturePackagesQuerySchema,
} from '@/lib/super-admin/feature-packages-schemas';

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
      return NextResponse.json(
        { error: { code: 'OP_INVALID_QUERY', message: queryResult.error.message } },
        { status: 400 }
      );
    }

    const { status, page, per_page } = queryResult.data;
    const offset = (page - 1) * per_page;

    let query = supabase
      .from('feature_packages')
      .select('*', { count: 'exact' })
      .order('display_order', { ascending: true })
      .range(offset, offset + per_page - 1);

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;

    if (error) {
      console.error('[super-admin/feature-packages GET]', error);
      return NextResponse.json(
        { error: { code: 'OP_DB_ERROR', message: error.message } },
        { status: 500 }
      );
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
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();

    const body = await request.json();
    const parseResult = FeaturePackageCreateSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'OP_INVALID_INPUT', message: parseResult.error.message, details: parseResult.error.issues } },
        { status: 400 }
      );
    }

    const input = parseResult.data;

    const { data: pkg, error } = await supabase
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
          { error: { code: 'OP_PACKAGE_KEY_DUPLICATE', message: 'package_key が既に存在します' } },
          { status: 409 }
        );
      }
      console.error('[super-admin/feature-packages POST]', error);
      return NextResponse.json(
        { error: { code: 'OP_DB_ERROR', message: error.message } },
        { status: 500 }
      );
    }

    // 監査ログ記録
    try {
      await supabase.from('admin_audit_logs').insert({
        actor_id: user.id,
        target_id: pkg.id,
        target_type: 'feature_package',
        action_type: 'create_feature_package',
        details: { package_key: input.package_key, display_name: input.display_name },
        severity: 'info',
        ip_address: request.headers.get('x-forwarded-for'),
      });
    } catch (auditErr) {
      console.warn('[super-admin/feature-packages POST] audit log failed (graceful):', auditErr);
    }

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

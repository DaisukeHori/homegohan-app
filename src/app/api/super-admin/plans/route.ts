/**
 * GET  /api/super-admin/plans — プラン一覧
 * POST /api/super-admin/plans — プラン新規作成 (draft)
 *
 * operator/02-api-spec.md §17 準拠
 * 権限: super_admin のみ
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { operatorForbiddenMessageOf } from '@/lib/api/error-responses';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import {
  PlanCreateSchema,
  PlansQuerySchema,
} from '@/lib/super-admin/plans-schemas';
import { internalError } from '@/lib/api/errors';
import { listCountOptions, resolveBeyondLastPage } from '@/lib/api/list-range';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { invalidInputResponse, invalidJsonBodyResponse, invalidQueryResponse, readJsonBody } from '@/lib/super-admin/validation-errors';
import { LIST_ORDERS, orderListBy } from '@/lib/api/list-order';

/** 一覧の構造化ログの function_name */
const LIST_ROUTE_NAME = 'GET /api/super-admin/plans';

export async function GET(request: NextRequest) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();

    const { searchParams } = request.nextUrl;
    const queryResult = PlansQuerySchema.safeParse({
      type: searchParams.get('type') ?? undefined,
      status: searchParams.get('status') ?? undefined,
      page: searchParams.get('page') ?? undefined,
      per_page: searchParams.get('per_page') ?? undefined,
    });

    if (!queryResult.success) {
      return invalidQueryResponse(queryResult.error.issues);
    }

    const { type, status, page, per_page } = queryResult.data;
    const offset = (page - 1) * per_page;

    // 一覧と、範囲外のページのときの件数の数え直し (src/lib/api/list-range.ts) は、同じ絞り込み (selectPlans) から作る
    const selectPlans = (options: { head?: boolean } = {}) => {
      let query = supabase
        .from('subscription_plans')
        .select('*', listCountOptions(options.head));

      if (type) query = query.eq('plan_type', type);
      if (status) query = query.eq('status', status);

      return query;
    };

    const { data, error, count } = await resolveBeyondLastPage(
      // 表示の順。同じ値は id の順で、ページの境目でも順が変わらない (#2139 T1)
      await orderListBy(selectPlans(), LIST_ORDERS.superAdminPlans).range(offset, offset + per_page - 1),
      () => selectPlans({ head: true }),
      LIST_ROUTE_NAME,
    );

    if (error) {
      return internalError(LIST_ROUTE_NAME, error, { userId: user.id }, { shape: 'nested' });
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
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: operatorForbiddenMessageOf(err) } }, { status: 403 });
    }
    console.error('[super-admin/plans GET]', err);
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
    const parseResult = PlanCreateSchema.safeParse(body);

    if (!parseResult.success) {
      return invalidInputResponse(parseResult.error.issues);
    }

    const input = parseResult.data;

    // feature_packages 配列を UUID[] に変換
    const featurePackageIds = input.feature_package_ids ?? [];

    // 書き込みは service_role だけ (requireRole を通したあと。運営の直接の書き込みを塞いだ。#1917 の続き)
    const { data: plan, error } = await getSupabaseAdmin()
      .from('subscription_plans')
      .insert({
        plan_key: input.plan_key,
        display_name: input.display_name,
        plan_type: input.plan_type,
        description: input.description ?? null,
        monthly_price_jpy: input.monthly_price_jpy ?? null,
        yearly_price_jpy: input.yearly_price_jpy ?? null,
        max_members: input.max_members ?? null,
        max_family_seats: input.max_family_seats ?? null,
        feature_packages: featurePackageIds,
        display_order: input.display_order ?? 0,
        trial_days: input.trial_days ?? 0,
        min_contract_months: input.min_contract_months ?? 1,
        auto_renew_default: input.auto_renew_default ?? true,
        banner_url: input.banner_url ?? null,
        status: 'draft',
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: { code: 'OP_PLAN_KEY_DUPLICATE', message: 'プランのキー (plan_key) は既に存在します' } },
          { status: 409 }
        );
      }
      return internalError('POST /api/super-admin/plans', error, { userId: user.id }, { shape: 'nested' });
    }

    // 監査ログ記録 (operator/07-audit-monitoring §3 準拠)
    await recordAdminAudit({
      supabase,
      actorId: user.id,
      targetId: plan.id,
      targetType: 'subscription_plan',
      actionType: 'create_plan',
      details: { plan_key: input.plan_key, display_name: input.display_name, plan_type: input.plan_type },
      severity: 'info',
      request,
      routeName: 'api/super-admin/plans POST',
    });

    return NextResponse.json({ data: plan }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: operatorForbiddenMessageOf(err) } }, { status: 403 });
    }
    console.error('[super-admin/plans POST]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}

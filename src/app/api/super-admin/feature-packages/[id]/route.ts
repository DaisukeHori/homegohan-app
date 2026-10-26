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
 *
 * 状態の遷移 (#2064): PATCH で status を送ったときは今の status を読み、遷移表 (FEATURE_PACKAGE_STATUS_TRANSITIONS。
 * 画面のボタンと同じ active → deprecated。deprecated は終端) に無い変更 (同じ状態への変更・廃止の取り消しを含む) を
 * 409 OP_FEATURE_PACKAGE_INVALID_TRANSITION で断る (書かず、監査ログも残さない)。DB には遷移を止めるトリガーが無い。
 * 今の status の読み込みの DB の失敗は 500、行が無ければ 404。更新は読んだ status のままのときだけ書く条件つきで、
 * 読んでから書くまでに別の操作が状態を変えていたら 0 行 → 読み直して、無ければ 404、あれば 409 CONFLICT_STALE_DATA
 * (書かず、監査ログも残さない)。status を送らない更新は読まず・検査せず、今までどおり条件なしで書く
 * (A/B テストの PATCH (#2059) と同じ形)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { operatorForbiddenMessageOf } from '@/lib/api/error-responses';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import {
  FEATURE_PACKAGE_INVALID_TRANSITION_ERROR_CODE,
  FeaturePackageUpdateSchema,
  featurePackageStatusTransitionMessage,
  isAllowedFeaturePackageStatusTransition,
} from '@/lib/super-admin/feature-packages-schemas';
import { STALE_DATA_ERROR_CODE, STALE_DATA_HTTP_STATUS } from '@/lib/admin/api-error-message';
import { internalError } from '@/lib/api/errors';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { invalidInputResponse, invalidJsonBodyResponse, readJsonBody } from '@/lib/super-admin/validation-errors';
import { isUuid } from '@/lib/http-params';

type RouteContext = { params: Promise<{ id: string }> };

/** 機能パッケージが無い (UUID の形でない id を含む) */
const PACKAGE_NOT_FOUND_RESPONSE = { error: { code: 'OP_PACKAGE_NOT_FOUND', message: '機能パッケージが見つかりません' } } as const;

/** 遷移表に無い状態の変更を断るときの HTTP ステータス (409 Conflict。今の状態と衝突する) */
const PACKAGE_INVALID_TRANSITION_HTTP_STATUS = 409;

/** 読んでから書くまでに別の操作が機能パッケージの状態を変えていた (条件つきの更新が 0 行) */
const PACKAGE_STALE_STATUS_RESPONSE = {
  error: { code: STALE_DATA_ERROR_CODE, message: '別の操作で機能パッケージの状態が先に変わりました。読み込み直してください' },
} as const;

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
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: operatorForbiddenMessageOf(err) } }, { status: 403 });
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

    // 状態を変えるときは、今の status を読んで遷移表で検査する (#2064)。読んだ status は更新の条件にも使う
    let currentStatus: string | null = null;
    if (input.status !== undefined) {
      const { data: current, error: currentError } = await supabase
        .from('feature_packages')
        .select('status')
        .eq('id', params.id)
        .maybeSingle();
      // 読めなかったときは 404 にしない (行が無いときだけ 404。#1917)
      if (currentError) {
        return internalError('PATCH /api/super-admin/feature-packages/[id]', currentError, { userId: user.id, table: 'feature_packages' }, { shape: 'nested' });
      }
      if (!current) {
        return NextResponse.json(PACKAGE_NOT_FOUND_RESPONSE, { status: 404 });
      }
      currentStatus = current.status;
      if (!isAllowedFeaturePackageStatusTransition(current.status, input.status)) {
        return NextResponse.json(
          {
            error: {
              code: FEATURE_PACKAGE_INVALID_TRANSITION_ERROR_CODE,
              message: featurePackageStatusTransitionMessage(current.status, input.status),
            },
          },
          { status: PACKAGE_INVALID_TRANSITION_HTTP_STATUS },
        );
      }
    }

    // 書き込みは service_role だけ (requireRole を通したあと。運営の直接の書き込みを塞いだ。#1917 の続き)
    let updateQuery = getSupabaseAdmin().from('feature_packages').update(updateData).eq('id', params.id);
    // 状態の変更は、読んだ status のままのときだけ書く (二度押し・2 つのタブで、2 本目が古い状態の検査のまま書かないように。#2064)
    if (currentStatus !== null) {
      updateQuery = updateQuery.eq('status', currentStatus);
    }
    const { data: updated, error } = await updateQuery.select().maybeSingle();

    if (error) {
      return internalError('PATCH /api/super-admin/feature-packages/[id]', error, { userId: user.id }, { shape: 'nested' });
    }
    if (!updated) {
      // 更新した行が無い (行が無い・読んでから書くまでに消された) ときは 404
      if (currentStatus === null) {
        return NextResponse.json(PACKAGE_NOT_FOUND_RESPONSE, { status: 404 });
      }
      // 状態の条件で 0 行: 読み直して、行が消えていれば 404、あれば別の操作が先に状態を変えたので 409 (書かず、監査も残さない)
      const { data: reread, error: rereadError } = await supabase
        .from('feature_packages')
        .select('id')
        .eq('id', params.id)
        .maybeSingle();
      if (rereadError) {
        return internalError('PATCH /api/super-admin/feature-packages/[id]', rereadError, { userId: user.id, table: 'feature_packages' }, { shape: 'nested' });
      }
      if (!reread) {
        return NextResponse.json(PACKAGE_NOT_FOUND_RESPONSE, { status: 404 });
      }
      return NextResponse.json(PACKAGE_STALE_STATUS_RESPONSE, { status: STALE_DATA_HTTP_STATUS });
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
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: operatorForbiddenMessageOf(err) } }, { status: 403 });
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
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: operatorForbiddenMessageOf(err) } }, { status: 403 });
    }
    console.error('[super-admin/feature-packages/[id] DELETE]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}

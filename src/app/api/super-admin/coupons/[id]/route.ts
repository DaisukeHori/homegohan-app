/**
 * GET    /api/super-admin/coupons/[id] — クーポン詳細
 * PATCH  /api/super-admin/coupons/[id] — クーポン更新
 * DELETE /api/super-admin/coupons/[id] — クーポン削除
 *
 * operator/01-data-model.md §3.5 / operator/04-plan-management.md §4.1 準拠
 * 権限: super_admin のみ
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { operatorForbiddenMessageOf } from '@/lib/api/error-responses';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { COUPON_VALID_UNTIL_BEFORE_FROM_MESSAGE, CouponUpdateSchema } from '@/lib/super-admin/coupons-schemas';
import { internalError } from '@/lib/api/errors';
import { couponValidityDay, couponValidUntilTimestamp } from '@/lib/super-admin/coupon-validity';
import { recordAdminAudit } from '@/lib/admin/audit';
import { couponInvalidInputResponse } from '@/lib/super-admin/coupon-errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { invalidJsonBodyResponse, readJsonBody } from '@/lib/super-admin/validation-errors';
import { isUuid } from '@/lib/http-params';

type RouteContext = { params: Promise<{ id: string }> };

/** クーポンが無い (UUID の形でない id を含む) */
const COUPON_NOT_FOUND_RESPONSE = { error: { code: 'OP_COUPON_NOT_FOUND', message: 'クーポンが見つかりません' } } as const;

export async function GET(_request: NextRequest, props: RouteContext) {
  const params = await props.params;
  try {
    await requireRole(['super_admin']);
    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json(COUPON_NOT_FOUND_RESPONSE, { status: 404 });
    }
    const supabase = await createClient();

    const { data: coupon, error } = await supabase
      .from('coupons')
      .select('*')
      .eq('id', params.id)
      .maybeSingle();

    // 読めなかったときは 404 にしない (行が無いときだけ 404。一時的な失敗で消えたように見せない。#1917)
    if (error) {
      return internalError('GET /api/super-admin/coupons/[id]', error, { table: 'coupons' }, { shape: 'nested' });
    }
    if (!coupon) {
      return NextResponse.json(COUPON_NOT_FOUND_RESPONSE, { status: 404 });
    }

    return NextResponse.json({ data: coupon });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: operatorForbiddenMessageOf(err) } }, { status: 403 });
    }
    console.error('[super-admin/coupons/[id] GET]', err);
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
    const parseResult = CouponUpdateSchema.safeParse(body);

    if (!parseResult.success) {
      // #1534: error.message は最初の issue の文 (POST と同じ形)。issues を JSON にした文字列は返さない
      return couponInvalidInputResponse(parseResult.error.issues);
    }

    const input = parseResult.data;
    const updateData: Record<string, unknown> = {};

    if (input.display_name !== undefined) updateData.display_name = input.display_name;
    if (input.status !== undefined) updateData.status = input.status;
    // #1483: 画面で選んだ JST の暦日を、その日の JST 23:59:59.999999 の時刻にして書く
    if (input.valid_until !== undefined) updateData.valid_until = couponValidUntilTimestamp(input.valid_until);
    if (input.max_uses !== undefined) updateData.max_uses = input.max_uses;
    if (input.applicable_plans !== undefined) updateData.applicable_plans = input.applicable_plans;
    if (input.applicable_to !== undefined) updateData.applicable_to = input.applicable_to;
    if (input.gross_margin_preview_jpy !== undefined) updateData.gross_margin_preview_jpy = input.gross_margin_preview_jpy;

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { error: { code: 'OP_NO_UPDATE', message: '更新するフィールドがありません' } },
        { status: 400 }
      );
    }

    // UUID の形でない id は DB に渡さず 404 (入力の検査 (400) のあと。uuid 型の列に渡すと 22P02 で失敗し、「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json(COUPON_NOT_FOUND_RESPONSE, { status: 404 });
    }

    const { data: existing, error: fetchErr } = await supabase
      .from('coupons')
      .select('id, code, valid_from')
      .eq('id', params.id)
      .maybeSingle();

    // 読めなかったときは 404 にしない (行が無いときだけ 404。一時的な失敗で消えたように見せない。#1917)
    if (fetchErr) {
      return internalError('PATCH /api/super-admin/coupons/[id]', fetchErr, { userId: user.id, table: 'coupons' }, { shape: 'nested' });
    }
    if (!existing) {
      return NextResponse.json(COUPON_NOT_FOUND_RESPONSE, { status: 404 });
    }

    // #1510: 新しい有効期限が、保存済みの有効開始日より前の日なら 400 (開始日より前の期限は、一度も使えないクーポンになる)。
    // POST (CouponCreateSchema) の valid_from <= valid_until と同じ決まりで、JST の暦日で比べる (同じ日は可)。
    // valid_from は PATCH で変えられないので、DB にある時刻を JST の暦日に戻して比べる。どちらも YYYY-MM-DD (年は 4 桁) なので、
    // 文字列の大小が日付の前後と同じ。valid_until を送らないときは比べない
    if (input.valid_until !== undefined && input.valid_until < couponValidityDay(existing.valid_from)) {
      // 形の誤り (Zod) の 400 と同じ本文 (#1534)。どの欄の誤りかを details に入れる。
      // POST で同じ誤り (CouponCreateSchema の refine) になったときと、message・details[].path・details[].message が同じになる
      return couponInvalidInputResponse([
        { code: 'custom', path: ['valid_until'], message: COUPON_VALID_UNTIL_BEFORE_FROM_MESSAGE },
      ]);
    }

    // 書き込みは service_role だけ (requireRole を通したあと。運営の直接の書き込みを塞いだ。#1917 の続き)
    const { data: updated, error } = await getSupabaseAdmin()
      .from('coupons')
      .update(updateData)
      .eq('id', params.id)
      .select()
      .maybeSingle();

    if (error) {
      return internalError('PATCH /api/super-admin/coupons/[id]', error, { userId: user.id }, { shape: 'nested' });
    }
    // 読んでから書くまでに消された (更新した行が無い) ときは 404 (#1917)
    if (!updated) {
      return NextResponse.json(COUPON_NOT_FOUND_RESPONSE, { status: 404 });
    }

    // 監査ログ記録
    await recordAdminAudit({
      supabase,
      actorId: user.id,
      targetId: params.id,
      targetType: 'coupon',
      actionType: 'update_coupon',
      details: { code: existing.code, changes: updateData },
      severity: 'info',
      request,
      routeName: 'api/super-admin/coupons/[id] PATCH',
    });

    return NextResponse.json({ data: updated });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: operatorForbiddenMessageOf(err) } }, { status: 403 });
    }
    console.error('[super-admin/coupons/[id] PATCH]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, props: RouteContext) {
  const params = await props.params;
  try {
    const user = await requireRole(['super_admin']);
    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、「DB の失敗は 500」に入る)
    if (!isUuid(params.id)) {
      return NextResponse.json(COUPON_NOT_FOUND_RESPONSE, { status: 404 });
    }
    const supabase = await createClient();

    const { data: existing, error: fetchErr } = await supabase
      .from('coupons')
      .select('id, code, uses_count')
      .eq('id', params.id)
      .maybeSingle();

    // 読めなかったときは 404 にしない (行が無いときだけ 404。一時的な失敗で消えたように見せない。#1917)
    if (fetchErr) {
      return internalError('DELETE /api/super-admin/coupons/[id]', fetchErr, { userId: user.id, table: 'coupons' }, { shape: 'nested' });
    }
    if (!existing) {
      return NextResponse.json(COUPON_NOT_FOUND_RESPONSE, { status: 404 });
    }

    // 利用中 (uses_count > 0) のクーポンは削除不可
    if (existing.uses_count > 0) {
      return NextResponse.json(
        { error: { code: 'OP_COUPON_IN_USE', message: '利用実績があるクーポンは削除できません。一時停止 (paused) に変更してください。' } },
        { status: 409 }
      );
    }

    // 書き込みは service_role だけ (requireRole を通したあと。運営の直接の書き込みを塞いだ。#1917 の続き)
    const { error: deleteErr } = await getSupabaseAdmin()
      .from('coupons')
      .delete()
      .eq('id', params.id);

    if (deleteErr) {
      return internalError('DELETE /api/super-admin/coupons/[id]', deleteErr, { userId: user.id }, { shape: 'nested' });
    }

    // 監査ログ記録
    await recordAdminAudit({
      supabase,
      actorId: user.id,
      targetId: params.id,
      targetType: 'coupon',
      actionType: 'delete_coupon',
      details: { code: existing.code },
      severity: 'warn',
      request,
      routeName: 'api/super-admin/coupons/[id] DELETE',
    });

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: operatorForbiddenMessageOf(err) } }, { status: 403 });
    }
    console.error('[super-admin/coupons/[id] DELETE]', err);
    return NextResponse.json({ error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } }, { status: 500 });
  }
}

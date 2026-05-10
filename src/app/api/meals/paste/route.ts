// src/app/api/meals/paste/route.ts
// (設計書 membership/02-flow-spec.md §12, 03-ui-spec.md §6)
// POST /api/meals/paste — 食事を家族メンバにペースト

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { PasteMealBodySchema } from '@/schemas/membership/meal-paste';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';

export async function POST(request: Request) {
  const supabase = await createClient();

  // 認証チェック
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }

  // リクエスト検証
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parsed = PasteMealBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: '入力値が不正です',
          details: parsed.error.flatten().fieldErrors,
        },
      },
      { status: 400 },
    );
  }

  const { source_meal_id, target_user_ids } = parsed.data;

  // RPC: paste_meal_to_family
  // シグネチャ: (p_source_meal_id UUID, p_target_user_ids UUID[]) RETURNS UUID (paste_group_id)
  const { data: paste_group_id, error: rpcError } = await supabase.rpc(
    'paste_meal_to_family',
    {
      p_source_meal_id: source_meal_id,
      p_target_user_ids: target_user_ids,
    },
  );

  if (rpcError) {
    const { code, status } = mapPgErrorToHttp(rpcError.message ?? '');

    if (rpcError.message?.includes('NOT_MEAL_OWNER')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.INSUFFICIENT_PERMISSION, message: '自分の食事のみペースト可能です' } },
        { status: 403 },
      );
    }
    if (rpcError.message?.includes('NOT_IN_FAMILY')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.NOT_IN_FAMILY, message: '家族グループに所属していません' } },
        { status: 403 },
      );
    }
    if (rpcError.message?.includes('TARGET_NOT_IN_FAMILY')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.USER_NOT_IN_FAMILY, message: 'ペースト先が同じ家族グループにいません' } },
        { status: 400 },
      );
    }

    console.error('[api/meals/paste] RPC error:', rpcError);
    return NextResponse.json(
      { error: { code: code === 'UNKNOWN' ? MembershipErrorCode.RPC_FAILED : code, message: 'ペーストに失敗しました' } },
      { status },
    );
  }

  return NextResponse.json({
    data: {
      paste_group_id,
      inserted_count: target_user_ids.length,
    },
  });
}

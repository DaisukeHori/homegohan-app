// src/app/api/family/members/me/share/route.ts
// (設計書 02-flow-spec.md §13)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { UpdateShareSettingsBodySchema } from '@/schemas/membership/share-settings';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { internalError } from '@/lib/api/errors';

export async function PATCH(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parsed = UpdateShareSettingsBodySchema.safeParse(body);
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

  const { share_meals, share_health, share_menu } = parsed.data;

  // 現在の設定値を取得してデフォルト値として使用。
  // 読めなかった (DB の失敗) ときは 500。既定の値で上書きしない (#1917 の続き。以前は失敗を捨て、送らなかった項目を
  // 既定の値 (健康は共有しない など) で書き換えていた)。家族に入っていない (行が無い) ときは今までどおり既定の値で RPC に任せる
  const { data: currentMember, error: currentMemberError } = await supabase
    .from('family_members')
    .select('share_meals, share_health, share_menu')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();
  if (currentMemberError) {
    return internalError('PATCH /api/family/members/me/share', currentMemberError, { userId: user.id, table: 'family_members' }, { shape: 'nested' });
  }

  const newShareMeals = share_meals ?? currentMember?.share_meals ?? true;
  const newShareHealth = share_health ?? currentMember?.share_health ?? false;
  const newShareMenu = share_menu ?? currentMember?.share_menu ?? true;

  const { data, error } = await supabase.rpc('update_my_share_settings', {
    p_share_meals: newShareMeals,
    p_share_health: newShareHealth,
    p_share_menu: newShareMenu,
  });

  if (error) {
    const { code, status } = mapPgErrorToHttp(error.message ?? '');
    return NextResponse.json(
      { error: { code, message: '共有設定の更新に失敗しました' } },
      { status },
    );
  }

  return NextResponse.json({ data }, { status: 200 });
}

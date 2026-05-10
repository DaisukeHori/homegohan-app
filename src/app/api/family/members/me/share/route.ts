// src/app/api/family/members/me/share/route.ts
// (設計書 02-flow-spec.md §13)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { UpdateShareSettingsBodySchema } from '@/schemas/membership/share-settings';

export async function PATCH(request: Request) {
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

  // 現在の設定値を取得してデフォルト値として使用
  const { data: currentMember } = await supabase
    .from('family_members')
    .select('share_meals, share_health, share_menu')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .single();

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

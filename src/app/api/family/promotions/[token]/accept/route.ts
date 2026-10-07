// src/app/api/family/promotions/[token]/accept/route.ts
// #1232: 対象者本人による昇格リクエスト受諾 (編入確定)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import {
  FamilyPromotionTokenParamsSchema,
  AcceptChildPromotionBodySchema,
} from '@/schemas/membership/family-promote-action';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const supabase = await createClient();
  const logger = createLogger('POST /api/family/promotions/[token]/accept', generateRequestId());

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }

  const { token } = await params;
  const tokenCheck = FamilyPromotionTokenParamsSchema.safeParse({ token });
  if (!tokenCheck.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'トークン形式が不正です' } },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const parsed = AcceptChildPromotionBodySchema.safeParse(
    typeof body === 'object' && body !== null ? body : {},
  );
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
  const { data, error } = await supabase.rpc('accept_child_promotion', {
    p_token: token,
    p_share_meals: share_meals,
    p_share_health: share_health,
    p_share_menu: share_menu,
  });
  if (error) {
    // #1232 v3 (G10): SQLSTATE (PostgrestError.code) を渡し 40P01 → CONFLICT_RETRY(409) を有効化
    const { code, status } = mapPgErrorToHttp(error.message ?? '', error.code);
    if (status >= 500) {
      // token はログに残さない (同意の証跡。db-logger は metadata の token キーをマスクするが、そもそも渡さない)
      logger.withUser(user.id).error('accept_child_promotion failed', error, { pg_code: error.code });
    }
    return NextResponse.json(
      { error: { code, message: '参加の承認に失敗しました' } },
      { status },
    );
  }

  // ★#1232 v3 (G12): accept_child_promotion は family_members 全行を返す。
  // レスポンスは {family_id, member_id, role} の最小 JSON に再構成する (素通し禁止)。
  const result = data as { id: string; family_id: string; role: string };
  return NextResponse.json(
    {
      data: {
        family_id: result.family_id,
        member_id: result.id,
        role: result.role,
      },
    },
    { status: 200 },
  );
}

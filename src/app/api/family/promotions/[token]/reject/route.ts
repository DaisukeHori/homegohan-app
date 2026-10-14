// src/app/api/family/promotions/[token]/reject/route.ts
// #1232: 対象者本人による昇格リクエスト拒否
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { FamilyPromotionTokenParamsSchema } from '@/schemas/membership/family-promote-action';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const supabase = await createClient();
  const logger = createLogger('POST /api/family/promotions/[token]/reject', generateRequestId());

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

  const { data, error } = await supabase.rpc('reject_child_promotion', { p_token: token });
  if (error) {
    // #1232 v3 (G10): SQLSTATE (PostgrestError.code) を渡し 40P01 → CONFLICT_RETRY(409) を有効化
    const { code, status } = mapPgErrorToHttp(error.message ?? '', error.code);
    if (status >= 500) {
      // token はログに残さない (同意の証跡)
      logger.withUser(user.id).error('reject_child_promotion failed', error, { pg_code: error.code });
    }
    return NextResponse.json(
      { error: { code, message: '参加の拒否に失敗しました' } },
      { status },
    );
  }

  // ★#1232 v3 (G12): reject_child_promotion は token 列を含む family_promotion_requests
  // 全行を返す (RPC 戻り値は列単位 GRANT (G8) をバイパスする)。RPC 戻り値を絶対に
  // そのまま返さず、最小 JSON に再構成する。ミューテーション感度テスト対象 (設計 §8-A)。
  const r = data as { id: string };
  return NextResponse.json({ data: { request_id: r.id, status: 'rejected' } }, { status: 200 });
}

// src/app/api/family/members/child/route.ts
// (設計書 02-flow-spec.md §8)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';

export async function POST(request: Request) {
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

  const parsed = body as { family_id?: string; display_name?: string; child_profile?: Record<string, unknown> };

  if (!parsed.family_id || !parsed.display_name) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'family_id と display_name は必須です' } },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc('add_family_child', {
    p_family_id: parsed.family_id,
    p_child_profile: parsed.child_profile ?? {},
  });

  if (error) {
    if (error.message?.includes('MEMBER_LIMIT_EXCEEDED')) {
      return NextResponse.json(
        { error: { code: MembershipErrorCode.MEMBER_LIMIT_EXCEEDED, message: 'メンバー数の上限に達しています' } },
        { status: 409 },
      );
    }
    const { code, status } = mapPgErrorToHttp(error.message ?? '');
    return NextResponse.json(
      { error: { code, message: '子供メンバーの追加に失敗しました' } },
      { status },
    );
  }

  return NextResponse.json({ data: { member: data } }, { status: 201 });
}

// src/app/api/family/members/[member_id]/remove/route.ts
// (設計書 02-flow-spec.md §11)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ member_id: string }> },
) {
  const { member_id } = await params;
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

  const parsed = body as { family_id?: string };

  if (!parsed.family_id) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'family_id は必須です' } },
      { status: 400 },
    );
  }

  // RPC の p_member_id は family_members.id (URL の [member_id])
  const { data, error } = await supabase.rpc('remove_family_member', {
    p_family_id: parsed.family_id,
    p_member_id: member_id,
  });

  if (error) {
    if (error.message?.includes('CANNOT_REMOVE_REPRESENTATIVE')) {
      return NextResponse.json(
        { error: { code: 'CANNOT_REMOVE_REPRESENTATIVE', message: '代表者は除名できません。先に代表者を譲渡してください。' } },
        { status: 409 },
      );
    }
    const { code, status } = mapPgErrorToHttp(error.message ?? '');
    return NextResponse.json(
      { error: { code, message: 'メンバーの除名に失敗しました' } },
      { status },
    );
  }

  return NextResponse.json({ data: { member: data } }, { status: 200 });
}

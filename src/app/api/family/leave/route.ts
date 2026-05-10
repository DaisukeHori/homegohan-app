// src/app/api/family/leave/route.ts
// (設計書 02-flow-spec.md §11)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';

export async function POST() {
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }

  const { data, error } = await supabase.rpc('leave_family');

  if (error) {
    if (error.message?.includes('IS_FAMILY_REPRESENTATIVE')) {
      return NextResponse.json(
        {
          error: {
            code: 'IS_FAMILY_REPRESENTATIVE',
            message: '代表者は脱退できません。先に代表者を他のメンバーに譲渡してください。',
          },
        },
        { status: 409 },
      );
    }
    const { code, status } = mapPgErrorToHttp(error.message ?? '');
    return NextResponse.json(
      { error: { code, message: '家族グループからの脱退に失敗しました' } },
      { status },
    );
  }

  return NextResponse.json({ data }, { status: 200 });
}

// src/app/api/family/leave/route.ts
// (設計書 02-flow-spec.md §11)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { notifyMemberLeft, readFamilyNoticeOfMember } from '@/lib/membership/exit-notification';

export async function POST() {
  const logger = createLogger('POST /api/family/leave', generateRequestId());
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }
  const log = logger.withUser(user.id);

  // 脱退すると、本人はこの家族グループを RLS で読めなくなる。代表者への通知に使う家族グループ名と代表者は、
  // RPC の前に読む (#1160)
  const notice = await readFamilyNoticeOfMember(supabase, user.id, log);

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

  // 代表者への通知メール (best-effort)。脱退はすでに完了しているので、失敗しても応答は変えない (#1160)
  await notifyMemberLeft({ scope: notice, log });

  return NextResponse.json({ data }, { status: 200 });
}

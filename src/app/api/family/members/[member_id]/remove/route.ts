// src/app/api/family/members/[member_id]/remove/route.ts
// (設計書 02-flow-spec.md §11)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { ErrorStatusMap, MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import {
  notifyMemberRemoved,
  readFamilyMemberToNotify,
  readFamilyNotice,
} from '@/lib/membership/exit-notification';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ member_id: string }> },
) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  const { member_id } = await params;
  const logger = createLogger('POST /api/family/members/[member_id]/remove', generateRequestId());
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }
  const log = logger.withUser(user.id);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.INVALID_REQUEST, message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parsed = body as { family_id?: string };

  if (!parsed.family_id) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.VALIDATION_ERROR, message: '家族のグループ (family_id) は必須です' } },
      { status: 400 },
    );
  }

  // 除名の通知メールに使う情報は、RPC の前に読む (#1160)。
  // - 家族グループ名
  // - 外される人の user_id。remove_family_member はすでに外れた行にも成功するので、active だった行だけを対象にする
  //   (アカウントを持たない子供メンバーは user_id が NULL で、送り先が無い)
  const [notice, removedUserId] = await Promise.all([
    readFamilyNotice(supabase, parsed.family_id, log),
    readFamilyMemberToNotify(supabase, parsed.family_id, member_id, log),
  ]);

  // RPC の p_member_id は family_members.id (URL の [member_id])
  const { data, error } = await supabase.rpc('remove_family_member', {
    p_family_id: parsed.family_id,
    p_member_id: member_id,
  });

  if (error) {
    // 返す code はどれも MembershipErrorCode の値 (画面は membershipErrorMessageOfBody で code から理由の文を引く。#1576)
    // 古い守り: remove_family_member は代表者を外そうとすると IS_FAMILY_REPRESENTATIVE を RAISE し、その 409 は下の
    // mapPgErrorToHttp が返す (CANNOT_REMOVE_REPRESENTATIVE を RAISE する SQL は無い)
    if (error.message?.includes(MembershipErrorCode.CANNOT_REMOVE_REPRESENTATIVE)) {
      return NextResponse.json(
        {
          error: {
            code: MembershipErrorCode.CANNOT_REMOVE_REPRESENTATIVE,
            message: '代表者は除名できません。先に代表者を譲渡してください。',
          },
        },
        { status: ErrorStatusMap[MembershipErrorCode.CANNOT_REMOVE_REPRESENTATIVE] },
      );
    }
    const { code, status } = mapPgErrorToHttp(error.message ?? '');
    return NextResponse.json(
      { error: { code, message: 'メンバーの除名に失敗しました' } },
      { status },
    );
  }

  // 外された本人への通知メール (best-effort)。除名はすでに完了しているので、失敗しても応答は変えない (#1160)
  await notifyMemberRemoved({ scope: notice, removedUserId, actorUserId: user.id, log });

  return NextResponse.json({ data: { member: data } }, { status: 200 });
}

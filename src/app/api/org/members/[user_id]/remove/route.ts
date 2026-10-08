// POST /api/org/members/[user_id]/remove
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { notifyMemberRemoved, readOrganizationNotice } from '@/lib/membership/exit-notification';

export async function POST(
  request: Request,
  { params }: { params: { user_id: string } },
) {
  const logger = createLogger('POST /api/org/members/[user_id]/remove', generateRequestId());
  const supabase = createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json(
      { error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } },
      { status: 401 },
    );
  }
  const log = logger.withUser(user.id);

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, org_role')
    .eq('id', user.id)
    .single();

  if (!profile?.org_role || !['owner', 'admin'].includes(profile.org_role as string) || !profile.organization_id) {
    return NextResponse.json(
      { error: { code: 'INSUFFICIENT_PERMISSION', message: 'owner/admin のみ除名可能です' } },
      { status: 403 },
    );
  }

  const targetUserId = params.user_id;
  if (!targetUserId) {
    return NextResponse.json(
      { error: { code: 'INVALID_BODY', message: 'user_id が必要です' } },
      { status: 400 },
    );
  }

  // 除名の通知メールに載せる組織名は、RPC の前に読む (#1160)
  const notice = await readOrganizationNotice(supabase, profile.organization_id, log);

  const { error: rpcError } = await supabase.rpc('remove_org_member', {
    p_organization_id: profile.organization_id,
    p_user_id: targetUserId,
  });

  if (rpcError) {
    const { code, status } = mapPgErrorToHttp(rpcError.message);
    return NextResponse.json({ error: { code, message: rpcError.message } }, { status });
  }

  // 外された本人への通知メール (best-effort)。除名はすでに完了しているので、失敗しても応答は変えない (#1160)。
  // 外された人は URL の user_id (RPC が、この組織の所属であることを確認した人)
  await notifyMemberRemoved({ scope: notice, removedUserId: targetUserId, actorUserId: user.id, log });

  return NextResponse.json({ ok: true });
}

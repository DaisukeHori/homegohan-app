// POST /api/org/leave
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { notifyMemberLeft, readOrganizationNoticeOfMember } from '@/lib/membership/exit-notification';
import { internalError } from '@/lib/api/errors';

export async function POST() {
  const logger = createLogger('POST /api/org/leave', generateRequestId());
  const supabase = createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json(
      { error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } },
      { status: 401 },
    );
  }
  const log = logger.withUser(user.id);

  // 脱退すると、本人はこの組織を RLS で読めなくなり、leave_org の戻り値の organization_id も NULL になる。
  // オーナーへの通知に使う組織名とオーナーは、RPC の前に読む (#1160)
  const notice = await readOrganizationNoticeOfMember(supabase, user.id, log);

  const { error: rpcError } = await supabase.rpc('leave_org');
  if (rpcError) {
    // RPC の生のエラー文は本文に出さない (#1172)。分かるコードは固定の文で返し、分からないものは汎用の 500 にして構造化ログに残す
    const { code, status } = mapPgErrorToHttp(rpcError.message);
    if (status >= 500) {
      return internalError('POST /api/org/leave', rpcError, { userId: user.id }, { shape: 'nested' });
    }
    return NextResponse.json({ error: { code, message: '組織からの脱退に失敗しました' } }, { status });
  }

  // オーナーへの通知メール (best-effort)。脱退はすでに完了しているので、失敗しても応答は変えない (#1160)
  await notifyMemberLeft({ scope: notice, log });

  return NextResponse.json({ ok: true });
}

// src/app/api/family/representative-transfer/propose/route.ts
// (設計書 02-flow-spec.md §10)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { resolveAuthEmails } from '@/lib/membership/resolve-auth-emails';
import { buildFamilyTransferAcceptUrl } from '@/lib/membership/urls';
import { sendEmail } from '@/lib/emails/send';
import { renderFamilyTransferProposedEmail } from '@/lib/emails/membership/family-transfer-proposed';
import {
  checkTransferProposeLimit,
  inviteThrottleFailureFromRpcError,
  inviteThrottleResponse,
} from '@/lib/membership/invite-throttle';

export async function POST(request: Request) {
  const logger = createLogger('POST /api/family/representative-transfer/propose', generateRequestId());
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }

  // #1163 譲渡提案メールの送信回数を制限する (提案者の user.id 単位)。
  // 判定できない (Redis 障害など) ときは例外がそのまま伝播し、RPC もメールも実行されない (fail-closed)。
  const throttle = await checkTransferProposeLimit(user.id);
  if (throttle) {
    return inviteThrottleResponse(throttle);
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

  const parsed = body as { family_id?: string; to_user_id?: string; reason?: string };

  if (!parsed.family_id || !parsed.to_user_id) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'family_id と to_user_id は必須です' } },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc('propose_family_representative_transfer', {
    p_family_id: parsed.family_id,
    p_to_user_id: parsed.to_user_id,
    // p_reason は DB 関数に存在しないため送らない
  });

  if (error) {
    // #1163 DB の 24 時間上限 (enforce_membership_daily_cap。家族の代表者譲渡と組織のオーナー譲渡の合計) に
    // 達したときは、アプリ層の上限と同じ 429 にする
    const dbThrottle = inviteThrottleFailureFromRpcError(error, { flow: 'transfer-propose', userId: user.id });
    if (dbThrottle) {
      return inviteThrottleResponse(dbThrottle);
    }
    const { code, status } = mapPgErrorToHttp(error.message ?? '');
    return NextResponse.json(
      { error: { code, message: '代表者譲渡の提案に失敗しました' } },
      { status },
    );
  }

  // 対象者にメール送信 (best-effort)。提案はすでに作成済みなので、失敗しても 201 を返し、ログに残す。
  // ログには宛先のメールアドレスを残さない。
  try {
    // 宛先のメールアドレスは auth.users にしか無い (user_profiles に email 列は無く、他人の行も RLS で読めない)。
    // 提案先の 1 人だけを service_role の Auth Admin API で引く (#1110)
    const toEmails = await resolveAuthEmails([parsed.to_user_id], { logger: logger.withUser(user.id) });
    const toEmail = toEmails.get(parsed.to_user_id);

    if (toEmail) {
      // 提案者本人の行と、提案者が所属する家族の名前 (どちらも本人のセッションで読める)
      const { data: fromUserProfile } = await supabase
        .from('user_profiles')
        .select('nickname')
        .eq('id', user.id)
        .single();

      const { data: familyGroup } = await supabase
        .from('family_groups')
        .select('name')
        .eq('id', parsed.family_id)
        .single();

      const proposalId = typeof data === 'string' ? data : (data as { proposal_id?: string })?.proposal_id ?? '';
      // リンクの基点は src/lib/membership/urls.ts に 1 つだけある (#1194)
      const acceptUrl = buildFamilyTransferAcceptUrl(proposalId);

      const envelope = renderFamilyTransferProposedEmail({
        to_email: toEmail,
        // 提案者のメールアドレスは受け取る側に見せない (ニックネームだけを載せる)
        from_name: fromUserProfile?.nickname || '代表者',
        family_name: familyGroup?.name ?? '家族グループ',
        accept_url: acceptUrl,
        reason: parsed.reason,
      });
      await sendEmail(envelope);
    }
  } catch (emailErr) {
    logger.withUser(user.id).error('譲渡提案メールの送信に失敗しました (提案は作成済み)', emailErr, {
      family_id: parsed.family_id,
      to_user_id: parsed.to_user_id,
    });
  }

  return NextResponse.json({ data: { proposal: data } }, { status: 201 });
}

// POST /api/org/owner-transfer/propose
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { sendEmail } from '@/lib/emails/send';
import { isEmailFailure } from '@/lib/emails/send-result';
import { renderOrgTransferProposedEmail } from '@/lib/emails/membership/org-transfer-proposed';
import { buildOrgTransferAcceptUrl } from '@/lib/membership/urls';
import {
  checkTransferProposeLimit,
  inviteThrottleFailureFromRpcError,
  inviteThrottleResponse,
} from '@/lib/membership/invite-throttle';
import { z } from 'zod';

const BodySchema = z.object({
  organization_id: z.string().uuid(),
  to_user_id: z.string().uuid(),
  reason: z.string().max(500).optional().nullable(),
});

/**
 * 譲渡先ユーザーのニックネーム (提案メールの宛名) を読む。読めなければ null (宛名はメールアドレスになる)。
 *
 * user_profiles の SELECT ポリシーは「本人の行だけ」(Users can view own profile) のため、提案者本人のセッションでは
 * 他のユーザー (譲渡先) の行は読めず、宛名がいつも既定のものになっていた。そこで service_role で読む。
 * 使うのは、提案者が対象組織の owner だと確認した (POST の権限チェックの) あとだけ。
 * 読む範囲は「譲渡先の id かつ対象組織の id」の 1 行に絞り、組織の外のユーザーのプロフィールは読まない。
 * 提案はすでに作成済みなので、読めなくても例外にせず、警告に残して null を返す (メールは宛名をアドレスにして送る)。
 */
async function readRecipientNickname(params: {
  organizationId: string;
  toUserId: string;
  actorUserId: string;
}): Promise<string | null> {
  const warn = (reason: string) =>
    createLogger('POST /api/org/owner-transfer/propose', generateRequestId())
      .withUser(params.actorUserId)
      .warn('譲渡先のニックネームを読めませんでした (提案メールの宛名はメールアドレスになります)', {
        organization_id: params.organizationId,
        to_user_id: params.toUserId,
        reason,
      });

  try {
    const { data, error } = await getSupabaseAdmin()
      .from('user_profiles')
      .select('nickname')
      .eq('id', params.toUserId)
      .eq('organization_id', params.organizationId)
      .maybeSingle();
    if (error) {
      warn(error.message);
      return null;
    }
    return typeof data?.nickname === 'string' && data.nickname !== '' ? data.nickname : null;
  } catch (err) {
    // service_role の設定が無い環境 (SUPABASE_SERVICE_ROLE_KEY など) では client を作れない
    warn(err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function POST(request: Request) {
  const supabase = createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json(
      { error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } },
      { status: 401 },
    );
  }

  // #1163 譲渡提案メールの送信回数を制限する (提案者の user.id 単位)。
  // 判定できない (Redis 障害など) ときは例外がそのまま伝播し、RPC もメールも実行されない (fail-closed)。
  const throttle = await checkTransferProposeLimit(user.id);
  if (throttle) {
    return inviteThrottleResponse(throttle);
  }

  let body: z.infer<typeof BodySchema>;
  try {
    const raw = await request.json();
    body = BodySchema.parse(raw);
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_BODY', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  // 権限チェック: caller が対象 org の owner である必要がある
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, org_role, nickname')
    .eq('id', user.id)
    .single();

  if (
    profile?.org_role !== 'owner' ||
    profile?.organization_id !== body.organization_id
  ) {
    return NextResponse.json(
      { error: { code: 'INSUFFICIENT_PERMISSION', message: 'owner のみ譲渡提案が可能です' } },
      { status: 403 },
    );
  }

  const { data: proposalId, error: rpcError } = await supabase.rpc('propose_org_owner_transfer', {
    p_organization_id: body.organization_id,
    p_to_user_id: body.to_user_id,
    // p_reason は DB 関数に存在しないため送らない
  });

  if (rpcError) {
    // #1163 DB の 24 時間上限 (enforce_membership_daily_cap。家族の代表者譲渡と組織のオーナー譲渡の合計) に
    // 達したときは、アプリ層の上限と同じ 429 にする。DB が返す生の文字列 'RATE_LIMITED' は見せない。
    const dbThrottle = inviteThrottleFailureFromRpcError(rpcError, { flow: 'transfer-propose', userId: user.id });
    if (dbThrottle) {
      return inviteThrottleResponse(dbThrottle);
    }
    const { code, status } = mapPgErrorToHttp(rpcError.message);
    return NextResponse.json({ error: { code, message: rpcError.message } }, { status });
  }

  if (!proposalId) {
    return NextResponse.json(
      { error: { code: 'RPC_FAILED', message: '提案の作成に失敗しました' } },
      { status: 500 },
    );
  }

  // リンクの基点は src/lib/membership/urls.ts に 1 つだけある (#1194)
  const acceptUrl = buildOrgTransferAcceptUrl(String(proposalId));
  const fromName = profile.nickname ?? user.email?.split('@')[0] ?? 'オーナー';

  const { data: orgData } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', body.organization_id)
    .single();

  // service_role なしでは auth.users のメールアドレスは取得できないため
  // 環境変数 SUPABASE_SERVICE_ROLE_KEY がある場合のみ管理者 API でメール取得
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (serviceKey) {
    try {
      const { createClient: createAdminClient } = await import('@supabase/supabase-js');
      const adminSupabase = createAdminClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        serviceKey,
        { auth: { autoRefreshToken: false, persistSession: false } },
      );
      const { data: toUserData } = await adminSupabase.auth.admin.getUserById(body.to_user_id);
      const toEmail = toUserData?.user?.email ?? null;

      if (toEmail) {
        // 宛名にするニックネーム。メールを送るときだけ、必要な 1 行を service_role で読む (読めなくても送る)
        const toNickname = await readRecipientNickname({
          organizationId: body.organization_id,
          toUserId: body.to_user_id,
          actorUserId: user.id,
        });
        const envelope = renderOrgTransferProposedEmail({
          to_email: toEmail,
          to_name: toNickname,
          from_name: fromName,
          org_name: orgData?.name ?? '組織',
          accept_url: acceptUrl,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().substring(0, 10),
          reason: body.reason,
        });
        const sent = await sendEmail(envelope);
        // sendEmail は配信の失敗で例外を投げず、結果で返す。失敗も下の catch で、他の失敗と同じように警告に残す
        if (isEmailFailure(sent)) throw sent.error;
      }
    } catch (emailErr) {
      console.warn('[api/org/owner-transfer/propose] メール送信失敗:', emailErr);
    }
  } else {
    console.info('[api/org/owner-transfer/propose] SUPABASE_SERVICE_ROLE_KEY 未設定のためメール送信スキップ', {
      proposalId,
      acceptUrl,
    });
  }

  return NextResponse.json({ proposal_id: proposalId });
}

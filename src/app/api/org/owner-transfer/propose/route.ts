// POST /api/org/owner-transfer/propose
import { createClient } from '@/lib/supabase/server';
import { formatLocalDate } from '@/lib/date-utils';
import { NextResponse } from 'next/server';
import { getSupabaseUrl } from '@/lib/env-required';
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

/** メールに書く有効期限 (提案から何日後か)。以前と同じ 7 日 */
const OWNER_TRANSFER_EMAIL_EXPIRY_DAYS = 7;
/** 1 日のミリ秒 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const BodySchema = z.object({
  organization_id: z.string().uuid(),
  to_user_id: z.string().uuid(),
  reason: z.string().max(500).optional().nullable(),
});

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

  // 送信先ユーザーのプロフィール取得 (メール通知用)
  const { data: toProfile } = await supabase
    .from('user_profiles')
    .select('nickname')
    .eq('id', body.to_user_id)
    .single();

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
      // 未設定なら MissingEnvError。下の catch が警告に残して、メールだけを諦める (提案の作成は成功のまま)
      const adminSupabase = createAdminClient(
        getSupabaseUrl(),
        serviceKey,
        { auth: { autoRefreshToken: false, persistSession: false } },
      );
      const { data: toUserData } = await adminSupabase.auth.admin.getUserById(body.to_user_id);
      const toEmail = toUserData?.user?.email ?? null;

      if (toEmail) {
        const envelope = renderOrgTransferProposedEmail({
          to_email: toEmail,
          to_name: toProfile?.nickname ?? null,
          from_name: fromName,
          org_name: orgData?.name ?? '組織',
          accept_url: acceptUrl,
          // メールに書く有効期限の日付は JST の暦日 (#1433。UTC の暦日だと JST 0:00〜8:59 の提案で 1 日前の日付になる)
          expires_at: formatLocalDate(new Date(Date.now() + OWNER_TRANSFER_EMAIL_EXPIRY_DAYS * MS_PER_DAY)),
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

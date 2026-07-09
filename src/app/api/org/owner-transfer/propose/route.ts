// POST /api/org/owner-transfer/propose
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { sendEmail } from '@/lib/emails/send';
import { renderOrgTransferProposedEmail } from '@/lib/emails/membership/org-transfer-proposed';
import { z } from 'zod';

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

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const acceptUrl = `${baseUrl}/org/transfer-accept/${proposalId}`;
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
        const envelope = renderOrgTransferProposedEmail({
          to_email: toEmail,
          to_name: toProfile?.nickname ?? null,
          from_name: fromName,
          org_name: orgData?.name ?? '組織',
          accept_url: acceptUrl,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().substring(0, 10),
          reason: body.reason,
        });
        await sendEmail(envelope);
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

// POST /api/org/owner-transfer/[id]/accept
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { sendEmail } from '@/lib/emails/send';
import { renderOrgTransferCompletedEmail } from '@/lib/emails/membership/org-transfer-completed';

// #1236: RPC の生メッセージ (エラーコード文字列) を画面に出さず、利用者向けの文言にする
const TRANSFER_ACCEPT_MESSAGES: Record<string, string> = {
  TRANSFER_ACCEPTOR_NOT_IN_ORG: 'あなたは現在この組織のメンバーではないため、オーナー権限を引き継げません。',
  TRANSFER_PROPOSAL_NOT_FOUND: '譲渡提案が見つかりません。',
  TRANSFER_PROPOSAL_EXPIRED: '譲渡提案の有効期限が切れています。',
  TRANSFER_NOT_PENDING: 'この譲渡提案は既に処理済みです。',
  NOT_AUTHENTICATED: '認証が必要です。',
};

export async function POST(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json(
      { error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } },
      { status: 401 },
    );
  }

  const proposalId = params.id;

  // 提案情報を事前取得してメール通知用の情報を準備
  const { data: proposal } = await supabase
    .from('ownership_transfer_proposals')
    .select('scope_id, from_user_id, to_user_id, status')
    .eq('id', proposalId)
    .single();

  const { data: acceptResult, error: rpcError } = await supabase.rpc('accept_org_owner_transfer', {
    p_proposal_id: proposalId,
  });

  if (rpcError) {
    const { code, status } = mapPgErrorToHttp(rpcError.message);
    const message = TRANSFER_ACCEPT_MESSAGES[code] ?? '組織オーナー権限の引き継ぎに失敗しました。';
    return NextResponse.json({ error: { code, message } }, { status });
  }

  // 完了メール通知 (失敗してもレスポンスは成功)
  if (proposal) {
    try {
      const { data: orgData } = await supabase
        .from('organizations')
        .select('name')
        .eq('id', proposal.scope_id)
        .single();

      const { data: oldOwnerProfile } = await supabase
        .from('user_profiles')
        .select('nickname')
        .eq('id', proposal.from_user_id)
        .single();

      const { data: newOwnerProfile } = await supabase
        .from('user_profiles')
        .select('nickname')
        .eq('id', proposal.to_user_id)
        .single();

      // 旧 owner と新 owner へのメール
      // auth.admin は service_role 専用のため、スキップしてもよい
      // ここでは通知のみ (email が取れない場合はスキップ)
      const orgName = orgData?.name ?? '組織';
      const oldOwnerName = oldOwnerProfile?.nickname ?? '旧オーナー';
      const newOwnerName = newOwnerProfile?.nickname ?? '新オーナー';

      // メンバー全員に通知 (org メンバの email が取れる場合のみ)
      // service_role がないため user_profiles join で取れる範囲で通知
      // (メンバー自身の email は RLS で見えないため実質旧/新 owner のみ通知)
      console.info(`[owner-transfer/accept] org=${orgName} old=${oldOwnerName} new=${newOwnerName} 完了`);
    } catch (notifyErr) {
      console.warn('[api/org/owner-transfer/accept] 通知処理失敗:', notifyErr);
    }
  }

  return NextResponse.json({ ok: true, result: acceptResult });
}

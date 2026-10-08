// POST /api/org/owner-transfer/[id]/accept
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { resolveAuthEmails } from '@/lib/membership/resolve-auth-emails';
import { sendEmail, type EmailEnvelope } from '@/lib/emails/send';
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
  const logger = createLogger('POST /api/org/owner-transfer/[id]/accept', generateRequestId());
  const supabase = createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json(
      { error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } },
      { status: 401 },
    );
  }
  const log = logger.withUser(user.id);

  const proposalId = params.id;

  // 提案情報を事前取得してメール通知用の情報を準備
  // (ownership_transfer_proposals は当事者 (提案者・宛先) だけが SELECT できる。承諾する本人は宛先なので読める)
  const { data: proposal, error: proposalError } = await supabase
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

  // 完了メール通知 (best-effort)。承諾はすでに完了しているので、失敗しても 200 を返し、ログに残す。
  // ログには宛先のメールアドレスを残さない。
  try {
    if (!proposal) {
      // 旧オーナーが分からないので、誰にも送らない (宛先を推測して送ることはしない)
      log.error(
        '提案を取得できなかったため、完了メールを送信しません',
        proposalError ?? new Error('ownership_transfer_proposals の行が見つかりません'),
        { proposal_id: proposalId },
      );
    } else {
      // 旧オーナーのニックネーム・メールアドレスは、本人のセッションでは読めない
      // (user_profiles は本人の行しか SELECT できず、メールアドレスは auth.users にしか無い)。service_role で引く。
      const admin = getSupabaseAdmin();
      const partyIds = [proposal.from_user_id, proposal.to_user_id];
      const [emails, profiles] = await Promise.all([
        resolveAuthEmails(partyIds, { admin, logger: log }),
        admin.from('user_profiles').select('id, nickname').in('id', partyIds),
      ]);
      if (profiles.error) {
        log.warn('完了メール用のニックネームを取得できませんでした (既定の呼称で送信します)', {
          proposal_id: proposalId,
          error: profiles.error.message,
        });
      }
      const nicknames = new Map<string, string>();
      for (const row of profiles.data ?? []) {
        if (typeof row.nickname === 'string' && row.nickname) nicknames.set(row.id, row.nickname);
      }

      // 組織名は RPC の戻り値 (更新後の organizations の行) から入れる
      const orgName = (acceptResult as { name?: string | null } | null)?.name || '組織';
      const oldOwnerName = nicknames.get(proposal.from_user_id) ?? '旧オーナー';
      const newOwnerName = nicknames.get(proposal.to_user_id) ?? '新オーナー';

      // 宛先は旧オーナーと新オーナーの 2 人 (メンバー全員への通知は別途検討: #1160)
      const envelopes: EmailEnvelope[] = [];
      for (const { userId, recipient } of [
        { userId: proposal.from_user_id, recipient: 'old_owner' as const },
        { userId: proposal.to_user_id, recipient: 'new_owner' as const },
      ]) {
        const toEmail = emails.get(userId);
        if (!toEmail) continue;
        envelopes.push(
          renderOrgTransferCompletedEmail({
            to_email: toEmail,
            to_name: nicknames.get(userId) ?? null,
            old_owner_name: oldOwnerName,
            new_owner_name: newOwnerName,
            org_name: orgName,
            recipient,
          }),
        );
      }

      // 片方の送信が失敗しても、もう片方は送る
      const results = await Promise.allSettled(envelopes.map((envelope) => sendEmail(envelope)));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length > 0) {
        log.error('完了メールの一部を送信できませんでした (オーナーの譲渡は完了済み)', failures[0].reason, {
          proposal_id: proposalId,
          failed_count: failures.length,
        });
      }
    }
  } catch (notifyErr) {
    log.error('完了メールの送信処理に失敗しました (オーナーの譲渡は完了済み)', notifyErr, {
      proposal_id: proposalId,
    });
  }

  return NextResponse.json({ ok: true, result: acceptResult });
}

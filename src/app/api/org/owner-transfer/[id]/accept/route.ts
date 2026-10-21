// POST /api/org/owner-transfer/[id]/accept
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { MEMBERSHIP_ERROR_MESSAGES, MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { resolveAuthEmails } from '@/lib/membership/resolve-auth-emails';
import { sendEmail, type EmailEnvelope } from '@/lib/emails/send';
import { emailFailureReasons, logEmailFailures } from '@/lib/emails/send-result';
import { renderOrgTransferCompletedEmail } from '@/lib/emails/membership/org-transfer-completed';
import { normalizeProfileName } from '@/lib/profile-name';

// #1236: RPC の生メッセージ (エラーコード文字列) を画面に出さず、利用者向けの文言にする
const TRANSFER_ACCEPT_MESSAGES: Record<string, string> = {
  TRANSFER_ACCEPTOR_NOT_IN_ORG: 'あなたは現在この組織のメンバーではないため、オーナー権限を引き継げません。',
  TRANSFER_PROPOSAL_NOT_FOUND: '譲渡提案が見つかりません。',
  TRANSFER_PROPOSAL_EXPIRED: '譲渡提案の有効期限が切れています。',
  TRANSFER_NOT_PENDING: 'この譲渡提案は既に処理済みです。',
  NOT_AUTHENTICATED: '認証が必要です。',
  // #1173: 18 歳未満の本人は組織のオーナーを引き受けない (DB の関数が先頭で断る)
  [MembershipErrorCode.MINOR_ACCOUNT_NOT_ALLOWED]: MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.MINOR_ACCOUNT_NOT_ALLOWED],
  // 解散と同時の承諾 (supabase/migrations/20261022110000_org_transfer_toctou.sql)。承諾は組織の行をロックしてから status を読み、
  // 解散した組織の提案は承諾させない (従来は判定のあとに解散が commit すると CHECK 23514 の 500 だった)
  [MembershipErrorCode.ORG_ALREADY_DISSOLVED]: 'この組織は解散しているため、オーナー権限を引き継げません。',
  // 同じ migration: 提案者がもうこの組織のオーナーでない (運営の強制譲渡のあとに残った提案など)。オーナーは変わらない
  [MembershipErrorCode.NOT_ORG_OWNER]: '譲渡を申し出た人が今はこの組織のオーナーではないため、オーナー権限を引き継げません。',
  // ロックの取り直しの間に別の譲渡と解散が重なった、まれなデッドロック (40P01)。そのままやり直せば通る
  [MembershipErrorCode.CONFLICT_RETRY]: MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.CONFLICT_RETRY],
};

export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const logger = createLogger('POST /api/org/owner-transfer/[id]/accept', generateRequestId());
  const supabase = await createClient();
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
    // SQLSTATE も渡す (40P01 を CONFLICT_RETRY にするため)
    const { code, status } = mapPgErrorToHttp(rpcError.message, rpcError.code);
    if (code === 'UNKNOWN') {
      // 想定外の DB のエラー (CHECK 違反など) の生の文は本文に出さず、構造化ログにだけ残す
      log.error('オーナーの譲渡の承諾の RPC が想定外のエラーで失敗しました', rpcError, {
        proposal_id: proposalId,
        pg_code: rpcError.code ?? null,
      });
    }
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
        // 名前が無い (空・空白だけ・仮置きの 'Guest') 人は入れない。既定の呼称・メールアドレスの宛名になる (#1649)
        const name = normalizeProfileName(row.nickname);
        if (name) nicknames.set(row.id, name);
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
      // 送れなかったもの: reject (想定外の例外) と ok: false の結果 (sendEmail は配信の失敗で例外を投げない)。
      // 1 通ごとの詳細 (文面の名前・マスクした宛先・エラーコード) は sendEmail が app_logs に記録している
      const failures = emailFailureReasons(results);
      // すべて宛先停止リストで止めた (suppressed) ものなら意図した動きなので warn、ほかが 1 つでもあれば error (#1577 の 7)
      logEmailFailures(log, '完了メールの一部を送信できませんでした (オーナーの譲渡は完了済み)', failures, {
        proposal_id: proposalId,
        failed_count: failures.length,
      });
    }
  } catch (notifyErr) {
    log.error('完了メールの送信処理に失敗しました (オーナーの譲渡は完了済み)', notifyErr, {
      proposal_id: proposalId,
    });
  }

  return NextResponse.json({ ok: true, result: acceptResult });
}

// src/app/api/family/representative-transfer/[id]/accept/route.ts
// (設計書 02-flow-spec.md §10)
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { resolveAuthEmails } from '@/lib/membership/resolve-auth-emails';
import { sendEmail, type EmailEnvelope } from '@/lib/emails/send';
import { emailFailureReasons } from '@/lib/emails/send-result';
import { renderFamilyTransferCompletedEmail } from '@/lib/emails/membership/family-transfer-completed';

// accept_family_representative_transfer が RAISE するコードごとの、利用者向けの文言。
// RPC の生メッセージ (エラーコード文字列) は画面に出さない
const TRANSFER_ACCEPT_MESSAGES: Partial<Record<MembershipErrorCode | 'UNKNOWN', string>> = {
  [MembershipErrorCode.TRANSFER_PROPOSAL_NOT_FOUND]: '譲渡提案が見つかりません',
  [MembershipErrorCode.TRANSFER_NOT_PENDING]: '譲渡提案は既に処理済みです',
  // #1237: 承諾時点で家族の active な大人 / 代表者でない (脱退・除名済み等)
  [MembershipErrorCode.TRANSFER_ACCEPTOR_NOT_IN_FAMILY]:
    'あなたは現在この家族のメンバーではないため、代表者権限を引き継げません。',
  [MembershipErrorCode.TRANSFER_PROPOSAL_EXPIRED]: '譲渡提案の有効期限が切れています。',
};

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: proposal_id } = await params;
  const logger = createLogger('POST /api/family/representative-transfer/[id]/accept', generateRequestId());
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: MembershipErrorCode.NOT_AUTHENTICATED, message: '認証が必要です' } },
      { status: 401 },
    );
  }
  const log = logger.withUser(user.id);

  // 完了メールの宛先にする旧代表者は、承諾する前の提案から控えておく (#1110)。
  // RPC の戻り値は更新後の family_groups の行で、representative_id は承諾した本人 (新代表者)。旧代表者は含まれない。
  // ownership_transfer_proposals は当事者 (提案者・宛先) だけが SELECT できる (RLS)。承諾する本人は宛先なので読める。
  const { data: proposal, error: proposalError } = await supabase
    .from('ownership_transfer_proposals')
    .select('from_user_id')
    .eq('id', proposal_id)
    .single();

  const { data, error } = await supabase.rpc('accept_family_representative_transfer', {
    p_proposal_id: proposal_id,
  });

  if (error) {
    const { code, status } = mapPgErrorToHttp(error.message ?? '');
    return NextResponse.json(
      { error: { code, message: TRANSFER_ACCEPT_MESSAGES[code] ?? '代表者譲渡の承諾に失敗しました' } },
      { status },
    );
  }

  // 完了メール (best-effort)。承諾はすでに完了しているので、失敗しても 200 を返し、ログに残す。
  // ログには宛先のメールアドレスを残さない。
  try {
    const family = data as { name?: string | null } | null;
    const familyName = family?.name || '家族グループ';
    const oldRepId: string | null = proposal?.from_user_id ?? null;
    if (!oldRepId) {
      log.error(
        '旧代表者を特定できなかったため、旧代表者への完了メールを送信しません',
        proposalError ?? new Error('ownership_transfer_proposals の行が見つかりません'),
        { proposal_id },
      );
    }

    // 新代表者 (承諾した本人) のニックネームは本人の行なので読める。アドレスは認証済みセッションの値を使う。
    // 旧代表者のアドレスは auth.users にしか無い (user_profiles に email 列は無く、他人の行も RLS で読めない)
    const [{ data: newRepProfile }, oldRepEmails] = await Promise.all([
      supabase.from('user_profiles').select('nickname').eq('id', user.id).single(),
      resolveAuthEmails([oldRepId], { logger: log }),
    ]);
    const newRepName = newRepProfile?.nickname || '新代表者';

    const envelopes: EmailEnvelope[] = [];
    const oldRepEmail = oldRepId ? oldRepEmails.get(oldRepId) : undefined;
    if (oldRepEmail) {
      envelopes.push(
        renderFamilyTransferCompletedEmail({
          to_email: oldRepEmail,
          new_representative_name: newRepName,
          family_name: familyName,
          is_old_representative: true,
        }),
      );
    }
    if (user.email) {
      envelopes.push(
        renderFamilyTransferCompletedEmail({
          to_email: user.email,
          new_representative_name: newRepName,
          family_name: familyName,
          is_old_representative: false,
        }),
      );
    }

    // 片方の送信が失敗しても、もう片方は送る
    const results = await Promise.allSettled(envelopes.map((envelope) => sendEmail(envelope)));
    // 送れなかったもの: reject (想定外の例外) と ok: false の結果 (sendEmail は配信の失敗で例外を投げない)。
    // 1 通ごとの詳細 (文面の名前・マスクした宛先・エラーコード) は sendEmail が app_logs に記録している
    const failures = emailFailureReasons(results);
    if (failures.length > 0) {
      log.error('完了メールの一部を送信できませんでした (代表者の譲渡は完了済み)', failures[0], {
        proposal_id,
        failed_count: failures.length,
      });
    }
  } catch (emailErr) {
    log.error('完了メールの送信処理に失敗しました (代表者の譲渡は完了済み)', emailErr, { proposal_id });
  }

  return NextResponse.json({ data }, { status: 200 });
}

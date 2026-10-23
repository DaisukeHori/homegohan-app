/**
 * POST /api/operator/membership/family/[id]/transfer
 * 家族代表者強制譲渡
 * 05-operator-emergency-ui.md §7 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { requireSuperAdmin } from '@/lib/auth/operator-permissions';
import { API_FORBIDDEN_CODE, API_FORBIDDEN_MESSAGE, authFailureNested, operatorMfaRequiredNested } from '@/lib/api/error-responses';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { internalError } from '@/lib/api/errors';
import { ErrorStatusMap, MembershipErrorCode } from '@/lib/errors/membership-errors';
import { dbErrorMentionsCode, isRaisedExceptionWithCode } from '@/lib/errors/db-raised-code';
import { resolveAuthEmails } from '@/lib/membership/resolve-auth-emails';
import { sendEmail } from '@/lib/emails/send';
import { emailFailureReasons, logEmailFailures } from '@/lib/emails/send-result';
import { renderForceTransferEmail } from '@/lib/emails/membership/operator-force-transfer';
import { normalizeProfileName } from '@/lib/profile-name';
import { z } from 'zod';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { recordAdminAudit } from '@/lib/admin/audit';
import { normalizeUuid } from '@/lib/http-params';
import { OperatorForceRepresentativeTransferResultSchema } from '@/lib/membership/operator-force-transfer-result';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/operator/membership/family/[id]/transfer';

const BodySchema = z.object({
  to_user_id: z.string().uuid(),
  reason: z.string().min(1).max(1000),
});

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(req);
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  const logger = createLogger(ROUTE_NAME, generateRequestId());
  try {
    const { userId: operatorId } = await requireSuperAdmin();
    const { id: familyId } = params;

    const body = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }
    const { reason } = parsed.data;
    // 本文の to_user_id は UUID の形を確かめたうえで小文字にそろえ、以後の RPC・監査・宛先の解決・役割の判定・ログには
    // そろえた値だけを使う (#1790)。Postgres の uuid は大文字小文字を区別せずに比べるので、大文字のままでも RPC は
    // 新しいオーナーに譲渡するが、DB から読んだメンバーの id (小文字) との `===` と emailMap のキーが外れ、
    // 新しいオーナーに一般メンバー向けの通知が届き、新オーナー欄のアドレスも空になる
    const to_user_id = normalizeUuid(parsed.data.to_user_id);

    // RPC 実行"前"の旧代表者と家族名の控え (#1209)。監査・通知に使うのは、RPC が家族の行をロックして読んだ旧代表者
    // (戻り値の old_rep_id。#1917) で、この控えは戻り値が古い形 (#1917 の migration の前の定義の DB。更新した後の行だけを返す) の
    // ときだけ使う。RPC の後に読み直すと「旧代表者」が新代表者自身になり、本当の旧代表者に旧オーナー向けの通知が届かず、
    // 新代表者宛の「旧オーナー」欄も新代表者自身のアドレスになる。
    // 控えはロックの外で読むので、運営 2 人がほぼ同時に同じ家族を譲渡すると、この譲渡の直前の代表者 (先の譲渡の相手) と食い違いうる。
    // 通知は best-effort (設計 §8) なので、ここで失敗しても譲渡は止めず、後段で通知だけを省く。
    // representative_id は active な行では NOT NULL (CHECK family_groups_active_has_representative)。解散した行は NULL (#1917) なので、型は NULL も受ける
    let preFg: { name: string | null; representative_id: string | null } | null = null;
    let preFgError: unknown = null;
    try {
      const { data, error } = await getSupabaseAdmin()
        .from('family_groups')
        .select('name, representative_id')
        .eq('id', familyId)
        .maybeSingle();
      preFg = data;
      preFgError = error;
    } catch (err) {
      preFgError = err;
    }

    const supabase = await createClient();

    // RPC 実行
    const { data: rpcData, error: rpcError } = await supabase.rpc('operator_force_representative_transfer', {
      p_family_id: familyId,
      p_new_rep_id: to_user_id,
      p_reason: reason,
    });

    if (rpcError) {
      // RPC の生のエラー文は本文に出さない (#1172)。分かるものは固定の文、それ以外は汎用の 500 にして構造化ログに残す
      // 譲渡先が退会の手続き中なら 409 (代表者にすると、その退会の最後のアカウントの削除が代表者の外部キーで失敗する。#1917 の続き)。
      // 家族の行のトリガー family_groups_representative_not_deleting
      // (supabase/migrations/20261023150000_account_deletion_family_representative_guard.sql) が P0001 + このコードの完全一致で止めた形だけを拾う。
      // エラーのコードの判定は共通の関数で行い、route では `.message` を読まない (#1917)
      if (isRaisedExceptionWithCode(rpcError, MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING)) {
        return NextResponse.json(
          {
            error: {
              code: MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING,
              message: '譲渡先のユーザーは退会の手続き中です',
            },
          },
          { status: ErrorStatusMap[MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING] },
        );
      }
      if (dbErrorMentionsCode(rpcError, 'TARGET_NOT_IN_FAMILY')) {
        return NextResponse.json(
          { error: { code: 'TARGET_NOT_IN_FAMILY', message: '譲渡先のユーザーはこの家族グループに所属していません' } },
          { status: 400 },
        );
      }
      if (dbErrorMentionsCode(rpcError, 'NOT_OPERATOR')) {
        // 文は認可の失敗 (下の catch の authFailureNested) の 403 と同じ日本語の固定の文 (#1917)
        return NextResponse.json({ error: { code: API_FORBIDDEN_CODE, message: API_FORBIDDEN_MESSAGE } }, { status: 403 });
      }
      // DB の二段階認証の判定 (OPERATOR_MFA_REQUIRED。cross/12 §11.4) で止まったら、ゲート (requireSuperAdmin) が二段階認証で止めたときと
      // 同じ 403 と日本語の固定の文にする (汎用の 500 にしない。#1917)
      const mfaRequired = operatorMfaRequiredNested(rpcError);
      if (mfaRequired) return mfaRequired;
      return internalError(ROUTE_NAME, rpcError, { userId: operatorId }, { shape: 'nested' });
    }

    const log = logger.withUser(operatorId);

    // 旧代表者と家族名 (#1917): RPC が家族の行を FOR NO KEY UPDATE でロックして読んだ旧代表者 (戻り値の old_rep_id。
    // membership_audit の old_rep_id と同じ値) と、更新した後の行の家族名。同時の譲渡があっても、この譲渡の直前の代表者になる。
    // 戻り値が古い形 (migration の前の定義の DB) のときだけ RPC の前の控えを使い、食い違いうることをログに残す
    // (譲渡は済んでいるので 500 にしない)。どちらも無ければ null (= 旧代表者が分からない。通知を省く)
    const rpcResult = OperatorForceRepresentativeTransferResultSchema.safeParse(rpcData);
    if (!rpcResult.success) {
      log.error(
        'operator_force_representative_transfer の戻り値に旧代表者 (old_rep_id) が無いため、RPC の前に読んだ旧代表者で監査と通知を出します (同時の譲渡では直前の代表者と食い違いうる)',
        rpcResult.error,
        { family_id: familyId, to_user_id },
      );
    }
    const beforeTransfer: { representativeId: string | null; name: string | null } | null = rpcResult.success
      ? { representativeId: rpcResult.data.old_rep_id, name: rpcResult.data.family_group.name }
      : preFg
        ? { representativeId: preFg.representative_id, name: preFg.name }
        : null;
    // 応答の data は従来どおり、更新した後の家族の行
    const family = rpcResult.success ? rpcResult.data.family_group : rpcData;

    // 監査ログ (#1571)。RPC が書く membership_audit とは別に、運営の操作として admin_audit_logs にも 1 行残す
    // (操作した人の IP・User-Agent はこちらにだけ残る)。記録に失敗しても操作は完了のまま (失敗は db-logger に残る)
    await recordAdminAudit({
      supabase,
      actorId: operatorId,
      actionType: 'super_admin.family.transfer_representative',
      targetId: familyId,
      targetType: 'family_group',
      details: { reason, to_user_id, from_user_id: beforeTransfer?.representativeId ?? null },
      severity: 'warn',
      request: req,
      routeName: ROUTE_NAME,
    });

    // 通知メール (best-effort)。譲渡はすでに完了しているので、失敗しても 200 を返し、ログに残す。
    // ログには宛先のメールアドレスを残さない。
    if (!beforeTransfer) {
      // 旧代表者が分からないまま送ると、旧代表者に一般メンバー向けの本文が届いてしまう。
      // 誤った宛先・本文で送るより、送らずにログへ残す (譲渡自体は完了している)。
      log.error(
        '譲渡前の家族情報を取得できなかったため、通知メールを送信しませんでした',
        preFgError ?? new Error('family_groups の行が見つかりません'),
        { family_id: familyId, to_user_id },
      );
      return NextResponse.json({ data: family });
    }

    try {
      const admin = getSupabaseAdmin();

      const { data: members, error: membersError } = await admin
        .from('family_members')
        .select('user_id')
        .eq('family_id', familyId)
        .eq('status', 'active');
      // 読めなかったときに「メンバーがいない」と区別がつかず、黙って誰にも送らなくなるのを防ぐ (下の catch で記録する)
      if (membersError) throw membersError;

      // アカウントを持たない子供は user_id が NULL (通知先にならない)。.in() に null を渡すと uuid として解釈できず失敗する
      const userIds = (members ?? [])
        .map((m) => m.user_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      // 旧代表者・家族名は上で決めた値を使う (RPC が家族の行のロックの下で読んだ旧代表者。更新した後の representative_id は新代表者)
      const familyName = beforeTransfer.name ?? '';
      // 旧代表者が分からない (解散した行は NULL。#1917) ときは null (= old_owner 役の宛先なし)
      const oldRepId = beforeTransfer.representativeId ?? null;

      // auth.users のメールアドレス。listUsers() は先頭 50 件しか返さないため、通知先と
      // 旧・新代表者の分だけを引く (#1204)。取得できなかった人は警告ログに残り、その人には送らない
      const emailMap = await resolveAuthEmails([...userIds, oldRepId, to_user_id], { admin, logger: log });

      const { data: profiles } = await admin
        .from('user_profiles')
        .select('id, nickname')
        .in('id', userIds);
      const nicknameMap: Record<string, string> = {};
      for (const p of profiles ?? []) {
        // 名前が無い (空・空白だけ・仮置きの 'Guest') 人は入れない。メールはアドレスを宛名にする (#1649)
        const name = normalizeProfileName(p.nickname);
        if (name) nicknameMap[p.id] = name;
      }

      const newOwnerEmail = emailMap.get(to_user_id) ?? '';
      const oldOwnerEmail = oldRepId ? (emailMap.get(oldRepId) ?? '') : '';

      const emailTasks = userIds.flatMap((uid) => {
        const recipientEmail = emailMap.get(uid);
        if (!recipientEmail) return [];

        let role: 'old_owner' | 'new_owner' | 'member' = 'member';
        if (uid === oldRepId) role = 'old_owner';
        if (uid === to_user_id) role = 'new_owner';

        const envelope = renderForceTransferEmail({
          recipient_email: recipientEmail,
          recipient_name: nicknameMap[uid] ?? null,
          scope: 'family',
          scope_name: familyName,
          old_owner_email: oldOwnerEmail,
          new_owner_email: newOwnerEmail,
          reason,
          recipient_role: role,
        });
        return [sendEmail(envelope)];
      });

      const results = await Promise.allSettled(emailTasks);
      // 送れなかったもの: reject (想定外の例外) と ok: false の結果 (sendEmail は配信の失敗で例外を投げない)。
      // 1 通ごとの詳細 (文面の名前・マスクした宛先・エラーコード) は sendEmail が app_logs に記録している
      const failures = emailFailureReasons(results);
      // 個別の送信失敗も握りつぶさず記録する (ログに宛先のメールアドレスは残さない)。
      // すべて宛先停止リストで止めた (suppressed) ものなら意図した動きなので warn、ほかが 1 つでもあれば error (#1577 の 7)
      logEmailFailures(log, '通知メールの一部を送信できませんでした', failures, {
        family_id: familyId,
        to_user_id,
        failed_count: failures.length,
      });
    } catch (emailErr) {
      log.error('通知メール送信処理に失敗しました (譲渡は完了済み)', emailErr, {
        family_id: familyId,
        to_user_id,
      });
    }

    return NextResponse.json({ data: family });
  } catch (err) {
    // 認可の失敗 (AuthError → 401 UNAUTHORIZED・ForbiddenError (MfaRequiredError を含む) → 403 FORBIDDEN) は、
    // 例外の文面 (err.message) を入れず日本語の固定の文で返す (#1917。code と nested の形は従来のまま)
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    // 本文は汎用メッセージだけにし、元のエラーは構造化ログに残す (#1172)
    return internalError(ROUTE_NAME, err, {}, { shape: 'nested' });
  }
}

/**
 * POST /api/operator/membership/org/[id]/dissolve
 * 組織強制解散
 * 05-operator-emergency-ui.md §7 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { requireSuperAdmin } from '@/lib/auth/operator-permissions';
import { authFailureNested, operatorMfaRequiredNested } from '@/lib/api/error-responses';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { internalError } from '@/lib/api/errors';
import { resolveAuthEmails } from '@/lib/membership/resolve-auth-emails';
import { sendEmail } from '@/lib/emails/send';
import { emailFailureReasons, logEmailFailures } from '@/lib/emails/send-result';
import { renderForceDissolveEmail } from '@/lib/emails/membership/operator-force-dissolve';
import { normalizeProfileName } from '@/lib/profile-name';
import { z } from 'zod';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { recordAdminAudit } from '@/lib/admin/audit';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/operator/membership/org/[id]/dissolve';

const BodySchema = z.object({
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
    const { id: orgId } = params;

    const body = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }
    const { reason } = parsed.data;

    // 解散前に全メンバ情報を取得 (解散後は取得困難)
    const admin = getSupabaseAdmin();
    const { data: preMembers, error: preMembersError } = await admin
      .from('user_profiles')
      .select('id, nickname')
      .eq('organization_id', orgId);

    const { data: preOrg } = await admin
      .from('organizations')
      .select('name')
      .eq('id', orgId)
      .single();

    const supabase = await createClient();

    // RPC 実行
    const { data: org, error: rpcError } = await supabase.rpc('operator_force_dissolve_org', {
      p_organization_id: orgId,
      p_reason: reason,
    });

    if (rpcError) {
      // DB の二段階認証の判定 (OPERATOR_MFA_REQUIRED。cross/12 §11.4) で止まったら、ゲート (requireSuperAdmin) が二段階認証で止めたときと
      // 同じ 403 と日本語の固定の文にする (汎用の 500 にしない。#1917)
      const mfaRequired = operatorMfaRequiredNested(rpcError);
      if (mfaRequired) return mfaRequired;
      return internalError(ROUTE_NAME, rpcError, { userId: operatorId }, { shape: 'nested' });
    }

    // 監査ログ (#1571)。RPC が書く membership_audit とは別に、運営の操作として admin_audit_logs にも 1 行残す
    // (操作した人の IP・User-Agent はこちらにだけ残る)。記録に失敗しても操作は完了のまま (失敗は db-logger に残る)
    await recordAdminAudit({
      supabase,
      actorId: operatorId,
      actionType: 'super_admin.organization.dissolve',
      targetId: orgId,
      targetType: 'organization',
      details: { reason },
      severity: 'critical',
      request: req,
      routeName: ROUTE_NAME,
    });

    // 通知メール (best-effort)。解散はすでに完了しているので、失敗しても 200 を返し、ログに残す。
    // ログには宛先のメールアドレスを残さない。
    const log = logger.withUser(operatorId);
    if (preMembersError) {
      // 宛先が分からないので送れない。黙ってスキップせず記録する (解散自体は完了している)
      log.error('解散前のメンバー一覧を取得できなかったため、通知メールを送信しませんでした', preMembersError, {
        organization_id: orgId,
      });
      return NextResponse.json({ data: org });
    }

    try {
      const userIds = (preMembers ?? []).map((m) => m.id);
      const nicknameMap: Record<string, string> = {};
      for (const m of preMembers ?? []) {
        // 名前が無い (空・空白だけ・仮置きの 'Guest') 人は入れない。メールはアドレスを宛名にする (#1649)
        const name = normalizeProfileName(m.nickname);
        if (name) nicknameMap[m.id] = name;
      }

      // auth.users のメールアドレス。listUsers() は先頭 50 件しか返さないため、通知先の分だけを引く (#1204)
      const emailMap = await resolveAuthEmails(userIds, { admin, logger: log });

      const orgName = preOrg?.name ?? '';
      const emailTasks = userIds.flatMap((uid) => {
        const recipientEmail = emailMap.get(uid);
        if (!recipientEmail) return [];
        const envelope = renderForceDissolveEmail({
          recipient_email: recipientEmail,
          recipient_name: nicknameMap[uid] ?? null,
          scope: 'organization',
          scope_name: orgName,
          reason,
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
        organization_id: orgId,
        failed_count: failures.length,
      });
    } catch (emailErr) {
      log.error('通知メール送信処理に失敗しました (解散は完了済み)', emailErr, { organization_id: orgId });
    }

    return NextResponse.json({ data: org });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    // 本文は汎用メッセージだけにし、元のエラーは構造化ログに残す (#1172)
    return internalError(ROUTE_NAME, err, {}, { shape: 'nested' });
  }
}

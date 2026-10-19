/**
 * POST /api/operator/membership/org/[id]/transfer
 * 組織 owner 強制譲渡
 * 05-operator-emergency-ui.md §7 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { requireSuperAdmin } from '@/lib/auth/operator-permissions';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { internalError } from '@/lib/api/errors';
import { resolveAuthEmails } from '@/lib/membership/resolve-auth-emails';
import { sendEmail } from '@/lib/emails/send';
import { emailFailureReasons, logEmailFailures } from '@/lib/emails/send-result';
import { renderForceTransferEmail } from '@/lib/emails/membership/operator-force-transfer';
import { normalizeProfileName } from '@/lib/profile-name';
import { z } from 'zod';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { recordAdminAudit } from '@/lib/admin/audit';
import { normalizeUuid } from '@/lib/http-params';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/operator/membership/org/[id]/transfer';

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
    // 本文の to_user_id は UUID の形を確かめたうえで小文字にそろえ、以後の RPC・監査・宛先の解決・役割の判定・ログには
    // そろえた値だけを使う (#1790)。Postgres の uuid は大文字小文字を区別せずに比べるので、大文字のままでも RPC は
    // 新しいオーナーに譲渡するが、DB から読んだメンバーの id (小文字) との `===` と emailMap のキーが外れ、
    // 新しいオーナーに一般メンバー向けの通知が届き、新オーナー欄のアドレスも空になる
    const to_user_id = normalizeUuid(parsed.data.to_user_id);

    // 通知メール用に、RPC 実行"前"の旧オーナーと組織名を控えておく (#1209)。
    // operator_force_owner_transfer は organizations.owner_id を新オーナーへ書き換えた後の行を返すため、
    // その戻り値 (org.owner_id) や RPC 後の読み直しでは「旧オーナー」が新オーナー自身になってしまう。
    // その結果、本当の旧オーナーに旧オーナー向けの通知が届かず、新オーナー宛の「旧オーナー」欄も
    // 新オーナー自身のアドレスになる。
    // 通知は best-effort (設計 §8) なので、ここで失敗しても譲渡は止めず、後段で通知だけを省く。
    let preOrg: { name: string | null; owner_id: string | null } | null = null;
    let preOrgError: unknown = null;
    try {
      const { data, error } = await getSupabaseAdmin()
        .from('organizations')
        .select('name, owner_id')
        .eq('id', orgId)
        .maybeSingle();
      preOrg = data;
      preOrgError = error;
    } catch (err) {
      preOrgError = err;
    }

    const supabase = await createClient();

    // RPC 実行
    const { data: org, error: rpcError } = await supabase.rpc('operator_force_owner_transfer', {
      p_organization_id: orgId,
      p_new_owner_id: to_user_id,
      p_reason: reason,
    });

    if (rpcError) {
      // RPC の生のエラー文は本文に出さない (#1172)。分かるものは固定の文、それ以外は汎用の 500 にして構造化ログに残す
      if (rpcError.message.includes('TARGET_NOT_IN_ORG')) {
        return NextResponse.json(
          { error: { code: 'TARGET_NOT_IN_ORG', message: '譲渡先のユーザーはこの組織に所属していません' } },
          { status: 400 },
        );
      }
      if (rpcError.message.includes('NOT_OPERATOR')) {
        return NextResponse.json({ error: { code: 'FORBIDDEN', message: '権限がありません' } }, { status: 403 });
      }
      return internalError(ROUTE_NAME, rpcError, { userId: operatorId }, { shape: 'nested' });
    }

    // 監査ログ (#1571)。RPC が書く membership_audit とは別に、運営の操作として admin_audit_logs にも 1 行残す
    // (操作した人の IP・User-Agent はこちらにだけ残る)。記録に失敗しても操作は完了のまま (失敗は db-logger に残る)
    await recordAdminAudit({
      supabase,
      actorId: operatorId,
      actionType: 'super_admin.organization.transfer_admin',
      targetId: orgId,
      targetType: 'organization',
      details: { reason, to_user_id, from_user_id: preOrg?.owner_id ?? null },
      severity: 'warn',
      request: req,
      routeName: ROUTE_NAME,
    });

    // 通知メール (best-effort)。譲渡はすでに完了しているので、失敗しても 200 を返し、ログに残す。
    // ログには宛先のメールアドレスを残さない。
    const log = logger.withUser(operatorId);
    if (!preOrg) {
      // 旧オーナーが分からないまま送ると、旧オーナーに一般メンバー向けの本文が届いてしまう。
      // 誤った宛先・本文で送るより、送らずにログへ残す (譲渡自体は完了している)。
      log.error(
        '譲渡前の組織情報を取得できなかったため、通知メールを送信しませんでした',
        preOrgError ?? new Error('organizations の行が見つかりません'),
        { organization_id: orgId, to_user_id },
      );
      return NextResponse.json({ data: org });
    }

    try {
      const admin = getSupabaseAdmin();

      // 全メンバ取得
      const { data: members, error: membersError } = await admin
        .from('user_profiles')
        .select('id, nickname')
        .eq('organization_id', orgId);
      // 読めなかったときに「メンバーがいない」と区別がつかず、黙って誰にも送らなくなるのを防ぐ (下の catch で記録する)
      if (membersError) throw membersError;

      const userIds = (members ?? []).map((m) => m.id);
      const nicknameMap: Record<string, string> = {};
      for (const m of members ?? []) {
        // 名前が無い (空・空白だけ・仮置きの 'Guest') 人は入れない。メールはアドレスを宛名にする (#1649)
        const name = normalizeProfileName(m.nickname);
        if (name) nicknameMap[m.id] = name;
      }

      // 旧 owner・組織名は RPC 実行前に控えた値を使う (RPC の戻り値の owner_id は新 owner)。
      // owner_id の列は active な行では NOT NULL (CHECK organizations_active_has_owner。#1103 項目 10 → #1917)。解散した行は NULL なので、控えの型は NULL も受ける。
      // 旧 owner が分からないときは null (= old_owner 役の宛先なし)
      const oldOwnerId = preOrg.owner_id;
      const orgName = preOrg.name ?? '';

      // auth.users のメールアドレス。listUsers() は先頭 50 件しか返さないため、通知先と
      // 旧・新オーナーの分だけを引く (#1204)。取得できなかった人は警告ログに残り、その人には送らない
      const emailMap = await resolveAuthEmails([...userIds, oldOwnerId, to_user_id], { admin, logger: log });

      // 旧 owner / 新 owner のメール取得
      const newOwnerEmail = emailMap.get(to_user_id) ?? '';
      const oldOwnerEmail = oldOwnerId ? (emailMap.get(oldOwnerId) ?? '') : '';

      const emailTasks = userIds.flatMap((uid) => {
        const recipientEmail = emailMap.get(uid);
        if (!recipientEmail) return [];

        let role: 'old_owner' | 'new_owner' | 'member' = 'member';
        if (uid === oldOwnerId) role = 'old_owner';
        if (uid === to_user_id) role = 'new_owner';

        const envelope = renderForceTransferEmail({
          recipient_email: recipientEmail,
          recipient_name: nicknameMap[uid] ?? null,
          scope: 'organization',
          scope_name: orgName,
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
        organization_id: orgId,
        to_user_id,
        failed_count: failures.length,
      });
    } catch (emailErr) {
      log.error('通知メール送信処理に失敗しました (譲渡は完了済み)', emailErr, {
        organization_id: orgId,
        to_user_id,
      });
    }

    return NextResponse.json({ data: org });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    // 本文は汎用メッセージだけにし、元のエラーは構造化ログに残す (#1172)
    return internalError(ROUTE_NAME, err, {}, { shape: 'nested' });
  }
}

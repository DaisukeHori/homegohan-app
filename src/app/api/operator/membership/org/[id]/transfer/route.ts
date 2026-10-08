/**
 * POST /api/operator/membership/org/[id]/transfer
 * 組織 owner 強制譲渡
 * 05-operator-emergency-ui.md §7 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { requireSuperAdmin } from '@/lib/auth/operator-permissions';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { resolveAuthEmails } from '@/lib/membership/resolve-auth-emails';
import { sendEmail } from '@/lib/emails/send';
import { renderForceTransferEmail } from '@/lib/emails/membership/operator-force-transfer';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  to_user_id: z.string().uuid(),
  reason: z.string().min(1).max(1000),
});

function getServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase service role env missing');
  return createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const logger = createLogger('POST /api/operator/membership/org/[id]/transfer', generateRequestId());
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
    const { to_user_id, reason } = parsed.data;

    // 通知メール用に、RPC 実行"前"の旧オーナーと組織名を控えておく (#1209)。
    // operator_force_owner_transfer は organizations.owner_id を新オーナーへ書き換えた後の行を返すため、
    // その戻り値 (org.owner_id) や RPC 後の読み直しでは「旧オーナー」が新オーナー自身になってしまう。
    // その結果、本当の旧オーナーに旧オーナー向けの通知が届かず、新オーナー宛の「旧オーナー」欄も
    // 新オーナー自身のアドレスになる。
    // 通知は best-effort (設計 §8) なので、ここで失敗しても譲渡は止めず、後段で通知だけを省く。
    let preOrg: { name: string | null; owner_id: string | null } | null = null;
    let preOrgError: unknown = null;
    try {
      const { data, error } = await getServiceRoleClient()
        .from('organizations')
        .select('name, owner_id')
        .eq('id', orgId)
        .maybeSingle();
      preOrg = data;
      preOrgError = error;
    } catch (err) {
      preOrgError = err;
    }

    const supabase = createClient();

    // RPC 実行
    const { data: org, error: rpcError } = await supabase.rpc('operator_force_owner_transfer', {
      p_organization_id: orgId,
      p_new_owner_id: to_user_id,
      p_reason: reason,
    });

    if (rpcError) {
      const code = rpcError.message.includes('TARGET_NOT_IN_ORG')
        ? 'TARGET_NOT_IN_ORG'
        : rpcError.message.includes('NOT_OPERATOR')
          ? 'FORBIDDEN'
          : 'INTERNAL_ERROR';
      return NextResponse.json({ error: { code, message: rpcError.message } }, { status: code === 'FORBIDDEN' ? 403 : 400 });
    }

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
      const admin = getServiceRoleClient();

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
        nicknameMap[m.id] = m.nickname ?? '';
      }

      // 旧 owner・組織名は RPC 実行前に控えた値を使う (RPC の戻り値の owner_id は新 owner)。
      // owner_id は NULL を許す列なので、旧 owner が居ない組織では null (= old_owner 役の宛先なし)
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
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failures.length > 0) {
        // 個別の送信失敗も握りつぶさず記録する (ログに宛先のメールアドレスは残さない)
        log.error('通知メールの一部を送信できませんでした', failures[0].reason, {
          organization_id: orgId,
          to_user_id,
          failed_count: failures.length,
        });
      }
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
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message } }, { status: 500 });
  }
}

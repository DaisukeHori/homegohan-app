/**
 * POST /api/operator/membership/family/[id]/transfer
 * 家族代表者強制譲渡
 * 05-operator-emergency-ui.md §7 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { requireSuperAdmin } from '@/lib/auth/operator-permissions';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
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
  const logger = createLogger('POST /api/operator/membership/family/[id]/transfer', generateRequestId());
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
    const { to_user_id, reason } = parsed.data;

    // 通知メール用に、RPC 実行"前"の旧代表者と家族名を控えておく (#1209)。
    // operator_force_representative_transfer は family_groups.representative_id を新代表者へ
    // 書き換えてから戻るため、RPC の後に読み直すと「旧代表者」が新代表者自身になってしまう。
    // その結果、本当の旧代表者に旧オーナー向けの通知が届かず、新代表者宛の「旧オーナー」欄も
    // 新代表者自身のアドレスになる。
    // 通知は best-effort (設計 §8) なので、ここで失敗しても譲渡は止めず、後段で通知だけを省く。
    let preFg: { name: string | null; representative_id: string } | null = null;
    let preFgError: unknown = null;
    try {
      const { data, error } = await getServiceRoleClient()
        .from('family_groups')
        .select('name, representative_id')
        .eq('id', familyId)
        .maybeSingle();
      preFg = data;
      preFgError = error;
    } catch (err) {
      preFgError = err;
    }

    const supabase = createClient();

    // RPC 実行
    const { data: family, error: rpcError } = await supabase.rpc('operator_force_representative_transfer', {
      p_family_id: familyId,
      p_new_rep_id: to_user_id,
      p_reason: reason,
    });

    if (rpcError) {
      const code = rpcError.message.includes('TARGET_NOT_IN_FAMILY')
        ? 'TARGET_NOT_IN_FAMILY'
        : rpcError.message.includes('NOT_OPERATOR')
          ? 'FORBIDDEN'
          : 'INTERNAL_ERROR';
      return NextResponse.json({ error: { code, message: rpcError.message } }, { status: code === 'FORBIDDEN' ? 403 : 400 });
    }

    // 通知メール (failed silent)
    if (!preFg) {
      // 旧代表者が分からないまま送ると、旧代表者に一般メンバー向けの本文が届いてしまう。
      // 誤った宛先・本文で送るより、送らずにログへ残す (譲渡自体は完了している)。
      logger.withUser(operatorId).error(
        '譲渡前の家族情報を取得できなかったため、通知メールを送信しませんでした',
        preFgError ?? new Error('family_groups の行が見つかりません'),
        { family_id: familyId, to_user_id },
      );
      return NextResponse.json({ data: family });
    }

    try {
      const admin = getServiceRoleClient();

      const { data: members } = await admin
        .from('family_members')
        .select('user_id')
        .eq('family_id', familyId)
        .eq('status', 'active');

      const userIds = (members ?? []).map((m) => m.user_id);
      const { data: authUsers } = await admin.auth.admin.listUsers();
      const emailMap: Record<string, string> = {};
      for (const u of authUsers?.users ?? []) {
        if (userIds.includes(u.id) && u.email) {
          emailMap[u.id] = u.email;
        }
      }

      const { data: profiles } = await admin
        .from('user_profiles')
        .select('id, nickname')
        .in('id', userIds);
      const nicknameMap: Record<string, string> = {};
      for (const p of profiles ?? []) {
        nicknameMap[p.id] = p.nickname ?? '';
      }

      // 旧代表者・家族名は RPC 実行前に控えた値を使う (RPC 後の representative_id は新代表者)
      const familyName = preFg.name ?? '';
      const oldRepId = preFg.representative_id;
      const newOwnerEmail = emailMap[to_user_id] ?? '';
      const oldOwnerEmail = oldRepId ? (emailMap[oldRepId] ?? '') : '';

      const emailTasks = userIds.map((uid) => {
        const recipientEmail = emailMap[uid];
        if (!recipientEmail) return Promise.resolve();

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
        return sendEmail(envelope);
      });

      const results = await Promise.allSettled(emailTasks);
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failures.length > 0) {
        // 個別の送信失敗も握りつぶさず記録する (ログに宛先のメールアドレスは残さない)
        logger.withUser(operatorId).error('通知メールの一部を送信できませんでした', failures[0].reason, {
          family_id: familyId,
          to_user_id,
          failed_count: failures.length,
        });
      }
    } catch (emailErr) {
      logger.withUser(operatorId).error('通知メール送信処理に失敗しました (譲渡は完了済み)', emailErr, {
        family_id: familyId,
        to_user_id,
      });
    }

    return NextResponse.json({ data: family });
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

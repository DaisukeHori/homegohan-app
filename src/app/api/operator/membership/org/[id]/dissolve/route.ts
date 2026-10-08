/**
 * POST /api/operator/membership/org/[id]/dissolve
 * 組織強制解散
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
import { emailFailureReasons } from '@/lib/emails/send-result';
import { renderForceDissolveEmail } from '@/lib/emails/membership/operator-force-dissolve';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
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
  const logger = createLogger('POST /api/operator/membership/org/[id]/dissolve', generateRequestId());
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
    const admin = getServiceRoleClient();
    const { data: preMembers, error: preMembersError } = await admin
      .from('user_profiles')
      .select('id, nickname')
      .eq('organization_id', orgId);

    const { data: preOrg } = await admin
      .from('organizations')
      .select('name')
      .eq('id', orgId)
      .single();

    const supabase = createClient();

    // RPC 実行
    const { data: org, error: rpcError } = await supabase.rpc('operator_force_dissolve_org', {
      p_organization_id: orgId,
      p_reason: reason,
    });

    if (rpcError) {
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: rpcError.message } },
        { status: 500 },
      );
    }

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
        nicknameMap[m.id] = m.nickname ?? '';
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
      if (failures.length > 0) {
        // 個別の送信失敗も握りつぶさず記録する (ログに宛先のメールアドレスは残さない)
        log.error('通知メールの一部を送信できませんでした', failures[0], {
          organization_id: orgId,
          failed_count: failures.length,
        });
      }
    } catch (emailErr) {
      log.error('通知メール送信処理に失敗しました (解散は完了済み)', emailErr, { organization_id: orgId });
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

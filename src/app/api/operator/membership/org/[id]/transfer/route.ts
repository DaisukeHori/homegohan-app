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
  try {
    await requireSuperAdmin();
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

    // 通知メール (failed silent)
    try {
      const admin = getServiceRoleClient();

      // 全メンバ取得
      const { data: members } = await admin
        .from('user_profiles')
        .select('id, nickname')
        .eq('organization_id', orgId);

      const userIds = (members ?? []).map((m) => m.id);
      const { data: authUsers } = await admin.auth.admin.listUsers();
      const emailMap: Record<string, string> = {};
      const nicknameMap: Record<string, string> = {};
      for (const m of members ?? []) {
        nicknameMap[m.id] = m.nickname ?? '';
      }
      for (const u of authUsers?.users ?? []) {
        if (userIds.includes(u.id) && u.email) {
          emailMap[u.id] = u.email;
        }
      }

      // 旧 owner / 新 owner のメール取得
      const oldOwnerId = (org as { owner_id?: string } | null)?.owner_id;
      const orgName = (org as { name?: string } | null)?.name ?? '';
      const newOwnerEmail = emailMap[to_user_id] ?? '';
      const oldOwnerEmail = oldOwnerId ? (emailMap[oldOwnerId] ?? '') : '';

      const emailTasks = userIds.map((uid) => {
        const recipientEmail = emailMap[uid];
        if (!recipientEmail) return Promise.resolve();

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
        return sendEmail(envelope);
      });

      await Promise.allSettled(emailTasks);
    } catch (emailErr) {
      console.error('[operator/org/transfer] 通知メール送信失敗 (graceful):', emailErr);
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

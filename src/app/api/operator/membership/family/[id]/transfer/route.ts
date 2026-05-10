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
    try {
      const admin = getServiceRoleClient();

      const { data: members } = await admin
        .from('family_members')
        .select('user_id')
        .eq('family_id', familyId)
        .eq('status', 'active');

      const { data: fg } = await admin
        .from('family_groups')
        .select('name, representative_id')
        .eq('id', familyId)
        .single();

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

      const familyName = fg?.name ?? '';
      const oldRepId = fg?.representative_id ?? null;
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

      await Promise.allSettled(emailTasks);
    } catch (emailErr) {
      console.error('[operator/family/transfer] 通知メール送信失敗 (graceful):', emailErr);
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

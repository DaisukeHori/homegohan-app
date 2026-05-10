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
import { sendEmail } from '@/lib/emails/send';
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
    const { reason } = parsed.data;

    // 解散前に全メンバ情報を取得 (解散後は取得困難)
    const admin = getServiceRoleClient();
    const { data: preMembers } = await admin
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

    // 通知メール (failed silent)
    try {
      const userIds = (preMembers ?? []).map((m) => m.id);
      const { data: authUsers } = await admin.auth.admin.listUsers();
      const emailMap: Record<string, string> = {};
      const nicknameMap: Record<string, string> = {};
      for (const m of preMembers ?? []) {
        nicknameMap[m.id] = m.nickname ?? '';
      }
      for (const u of authUsers?.users ?? []) {
        if (userIds.includes(u.id) && u.email) {
          emailMap[u.id] = u.email;
        }
      }

      const orgName = preOrg?.name ?? '';
      const emailTasks = userIds.map((uid) => {
        const recipientEmail = emailMap[uid];
        if (!recipientEmail) return Promise.resolve();
        const envelope = renderForceDissolveEmail({
          recipient_email: recipientEmail,
          recipient_name: nicknameMap[uid] ?? null,
          scope: 'organization',
          scope_name: orgName,
          reason,
        });
        return sendEmail(envelope);
      });

      await Promise.allSettled(emailTasks);
    } catch (emailErr) {
      console.error('[operator/org/dissolve] 通知メール送信失敗 (graceful):', emailErr);
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

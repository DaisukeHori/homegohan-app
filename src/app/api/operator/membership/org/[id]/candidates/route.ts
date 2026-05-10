/**
 * GET /api/operator/membership/org/[id]/candidates
 * 指定組織の transferable メンバ一覧を返す (service_role 経由)
 * 05-operator-emergency-ui.md §E 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { requireSuperAdmin } from '@/lib/auth/operator-permissions';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';

export const dynamic = 'force-dynamic';

function getServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase service role env missing');
  }
  return createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    await requireSuperAdmin();
    const { id: orgId } = params;

    const admin = getServiceRoleClient();

    const { data, error } = await admin
      .from('user_profiles')
      .select('id, nickname, org_role, last_login_at')
      .eq('organization_id', orgId)
      .neq('org_role', 'owner')
      .order('last_login_at', { ascending: false, nullsFirst: false });

    if (error) {
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: error.message } },
        { status: 500 },
      );
    }

    // auth.users からメールアドレスを取得
    const userIds = (data ?? []).map((r) => r.id);
    const emailMap: Record<string, string> = {};

    if (userIds.length > 0) {
      const { data: authUsers } = await admin.auth.admin.listUsers();
      for (const u of authUsers?.users ?? []) {
        if (userIds.includes(u.id) && u.email) {
          emailMap[u.id] = u.email;
        }
      }
    }

    const candidates = (data ?? []).map((row) => ({
      id: row.id,
      nickname: row.nickname,
      org_role: row.org_role,
      last_login_at: row.last_login_at,
      email: emailMap[row.id] ?? null,
    }));

    return NextResponse.json({ data: candidates });
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

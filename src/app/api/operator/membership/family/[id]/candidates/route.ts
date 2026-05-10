/**
 * GET /api/operator/membership/family/[id]/candidates
 * 指定家族グループの transferable メンバ一覧を返す (service_role 経由)
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
  if (!url || !key) throw new Error('Supabase service role env missing');
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
    const { id: familyId } = params;

    const admin = getServiceRoleClient();

    // adult ロールの active メンバを candidate とする
    const { data: members, error } = await admin
      .from('family_members')
      .select('user_id, role, joined_at')
      .eq('family_id', familyId)
      .eq('status', 'active')
      .in('role', ['adult', 'representative'])
      .neq('role', 'representative')
      .order('joined_at', { ascending: true });

    if (error) {
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: error.message } },
        { status: 500 },
      );
    }

    const userIds = (members ?? []).map((m) => m.user_id);

    // user_profiles からニックネームを取得
    const { data: profiles } = await admin
      .from('user_profiles')
      .select('id, nickname, last_login_at')
      .in('id', userIds);

    const profileMap: Record<string, { nickname: string | null; last_login_at: string | null }> = {};
    for (const p of profiles ?? []) {
      profileMap[p.id] = { nickname: p.nickname, last_login_at: p.last_login_at };
    }

    // email 取得
    const { data: authUsers } = await admin.auth.admin.listUsers();
    const emailMap: Record<string, string> = {};
    for (const u of authUsers?.users ?? []) {
      if (userIds.includes(u.id) && u.email) {
        emailMap[u.id] = u.email;
      }
    }

    const candidates = (members ?? []).map((m) => ({
      id: m.user_id,
      role: m.role,
      nickname: profileMap[m.user_id]?.nickname ?? null,
      email: emailMap[m.user_id] ?? null,
      last_login_at: profileMap[m.user_id]?.last_login_at ?? null,
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

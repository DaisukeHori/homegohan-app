/**
 * GET /api/org/stats — 組織ダッシュボード統計 API
 * org_admin ロール必須
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      throw new AuthError('AUTH_UNAUTHENTICATED');
    }
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('organization_id, roles')
      .eq('id', user.id)
      .single();
    if (!profile?.roles?.includes('org_admin') || !profile?.organization_id) {
      throw new ForbiddenError('PERM_DENIED', 'org_admin role required');
    }

    const orgId = profile.organization_id;

    // メンバー数
    const { count: memberCount } = await supabase
      .from('user_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId);

    return NextResponse.json({
      stats: {
        member_count: memberCount ?? 0,
        organization_id: orgId,
      },
    });
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

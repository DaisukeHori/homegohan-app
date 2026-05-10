// POST /api/org/members/[user_id]/remove
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { mapPgErrorToHttp } from '@/lib/errors/membership-errors';

export async function POST(
  request: Request,
  { params }: { params: { user_id: string } },
) {
  const supabase = createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json(
      { error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } },
      { status: 401 },
    );
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, org_role')
    .eq('id', user.id)
    .single();

  if (!profile?.org_role || !['owner', 'admin'].includes(profile.org_role as string) || !profile.organization_id) {
    return NextResponse.json(
      { error: { code: 'INSUFFICIENT_PERMISSION', message: 'owner/admin のみ除名可能です' } },
      { status: 403 },
    );
  }

  const targetUserId = params.user_id;
  if (!targetUserId) {
    return NextResponse.json(
      { error: { code: 'INVALID_BODY', message: 'user_id が必要です' } },
      { status: 400 },
    );
  }

  const { error: rpcError } = await supabase.rpc('remove_org_member', {
    p_organization_id: profile.organization_id,
    p_user_id: targetUserId,
  });

  if (rpcError) {
    const { code, status } = mapPgErrorToHttp(rpcError.message);
    return NextResponse.json({ error: { code, message: rpcError.message } }, { status });
  }

  return NextResponse.json({ ok: true });
}

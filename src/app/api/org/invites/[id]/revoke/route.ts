// src/app/api/org/invites/[id]/revoke/route.ts
// (設計書 02-flow-spec.md §3 — POST /api/org/invites/{id}/revoke)
// owner/admin のみ実行可 (RLS + org ロール確認)

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { mapPgErrorToHttp } from '@/lib/errors/membership-errors';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } },
      { status: 401 },
    );
  }

  // 呼び出し者が owner/admin かを user_profiles で確認
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('org_role, organization_id')
    .eq('id', user.id)
    .single();

  const allowedRoles = ['owner', 'admin'];
  if (!profile?.org_role || !allowedRoles.includes(profile.org_role as string)) {
    return NextResponse.json(
      { error: { code: 'INSUFFICIENT_PERMISSION', message: 'owner/admin のみ取消可能です' } },
      { status: 403 },
    );
  }

  const { error } = await supabase.rpc('revoke_org_invite', { p_invite_id: id });

  if (error) {
    const { code, status } = mapPgErrorToHttp(error.message);
    return NextResponse.json(
      { error: { code, message: error.message } },
      { status },
    );
  }

  return NextResponse.json({ ok: true });
}

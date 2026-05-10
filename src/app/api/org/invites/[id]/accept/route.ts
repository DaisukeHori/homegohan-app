// src/app/api/org/invites/[id]/accept/route.ts
// (設計書 02-flow-spec.md §1.2 Happy path — POST /api/org/invites/{token}/accept)
// Note: [id] slug is used for route deduplication; the value is the invite token.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { mapPgErrorToHttp } from '@/lib/errors/membership-errors';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: token } = await params;

  const supabase = createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } },
      { status: 401 },
    );
  }

  const { data, error } = await supabase.rpc('accept_org_invite', { p_token: token });

  if (error) {
    const { code, status } = mapPgErrorToHttp(error.message);
    return NextResponse.json(
      { error: { code, message: error.message } },
      { status },
    );
  }

  // accept_org_invite returns updated user_profiles row
  const profile = data as { organization_id: string | null; org_role?: string | null } | null;

  return NextResponse.json({
    ok: true,
    organization_id: profile?.organization_id ?? null,
    role: (profile as Record<string, unknown>)?.org_role ?? null,
  });
}

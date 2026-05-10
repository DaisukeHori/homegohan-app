// src/app/api/org/invites/[id]/reject/route.ts
// (設計書 02-flow-spec.md §3 — POST /api/org/invites/{token}/reject)
// 認証不要 (RPC は anon/authenticated 両対応)
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

  const { error } = await supabase.rpc('reject_org_invite', { p_token: token });

  if (error) {
    const { code, status } = mapPgErrorToHttp(error.message);
    return NextResponse.json(
      { error: { code, message: error.message } },
      { status },
    );
  }

  return NextResponse.json({ ok: true });
}

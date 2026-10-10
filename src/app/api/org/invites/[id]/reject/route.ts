// src/app/api/org/invites/[id]/reject/route.ts
// (設計書 02-flow-spec.md §3 — POST /api/org/invites/{token}/reject)
// 認証不要 (RPC は anon/authenticated 両対応)
// Note: [id] slug is used for route deduplication; the value is the invite token.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { internalError } from '@/lib/api/errors';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: token } = await params;

  const supabase = createClient();

  const { error } = await supabase.rpc('reject_org_invite', { p_token: token });

  if (error) {
    // RPC の生のエラー文は本文に出さない (#1172)。分かるコードは固定の文で返し、分からないものは汎用の 500 にして構造化ログに残す
    const { code, status } = mapPgErrorToHttp(error.message);
    if (status >= 500) {
      return internalError('POST /api/org/invites/[id]/reject', error, {}, { shape: 'nested' });
    }
    return NextResponse.json({ error: { code, message: '招待の辞退に失敗しました' } }, { status });
  }

  return NextResponse.json({ ok: true });
}

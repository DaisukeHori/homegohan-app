// POST /api/org/owner-transfer/[id]/decline
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { mapPgErrorToHttp } from '@/lib/errors/membership-errors';

export async function POST(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json(
      { error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } },
      { status: 401 },
    );
  }

  const proposalId = params.id;

  // to_user_id = auth.uid() かつ status='pending' の行のみ更新
  const { data, error } = await supabase
    .from('ownership_transfer_proposals')
    .update({ status: 'rejected', responded_at: new Date().toISOString() })
    .eq('id', proposalId)
    .eq('to_user_id', user.id)
    .eq('status', 'pending')
    .select();

  if (error) {
    const { code, status } = mapPgErrorToHttp(error.message);
    return NextResponse.json({ error: { code, message: error.message } }, { status });
  }

  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: { code: 'TRANSFER_NOT_PENDING', message: '対象の提案が見つからないか、すでに処理済みです' } },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true });
}

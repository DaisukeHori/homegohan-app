// POST /api/org/leave
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { mapPgErrorToHttp } from '@/lib/errors/membership-errors';

export async function POST() {
  const supabase = createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json(
      { error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } },
      { status: 401 },
    );
  }

  const { error: rpcError } = await supabase.rpc('leave_org');
  if (rpcError) {
    const { code, status } = mapPgErrorToHttp(rpcError.message);
    return NextResponse.json({ error: { code, message: rpcError.message } }, { status });
  }

  return NextResponse.json({ ok: true });
}

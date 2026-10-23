import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { INVALID_ID_PARAM_CODE, INVALID_ID_PARAM_MESSAGE, isUuid } from '@/lib/http-params';

// インサイトを既読にする
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const { id } = await params;
  // uuid 型の列に UUID でない文字列を渡すと 22P02 で 500 になるので、DB に投げる前に 400 にする (#1478)
  if (!isUuid(id)) {
    return NextResponse.json({ error: INVALID_ID_PARAM_MESSAGE, code: INVALID_ID_PARAM_CODE }, { status: 400 });
  }

  const { error } = await supabase
    .from('health_insights')
    .update({ is_read: true })
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) {
    return internalError('POST /api/health/insights/[id]/read', error, { userId: user.id, table: 'health_insights' });
  }

  return NextResponse.json({ success: true });
}


import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * 買い物リスト再生成リクエストのステータス確認API
 */
export async function GET(request: Request) {
  const supabase = createClient(cookies());
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const requestId = searchParams.get('requestId');

  if (!requestId) {
    return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('shopping_list_requests')
    .select('id, status, progress, result')
    .eq('id', requestId)
    .eq('user_id', user.id)
    .single();

  if (error) {
    console.error('Failed to get shopping list request status:', error);
    return NextResponse.json({ error: 'Request not found' }, { status: 404 });
  }

  return NextResponse.json({
    requestId: data.id,
    status: data.status,
    progress: data.progress,
    result: data.result,
  });
}

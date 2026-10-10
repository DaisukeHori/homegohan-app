import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { shoppingListRequestResultForResponse } from '@/lib/shopping-list-request-error';

/**
 * 買い物リスト再生成リクエストのステータス確認API
 */
export async function GET(request: Request) {
  const supabase = await createClient();
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

  // result.error には、Edge Function (regenerate-shopping-list-v2) が catch で捕まえた例外の文面がそのまま入っている
  // (DB の生のエラー文・外部の AI の応答の本文)。画面は result.error をそのまま出すので、こちらで書いた文 (同意) だけを
  // そのまま返し、それ以外は固定の文にする。成功の stats などほかの項目はそのまま返す (#1172)
  return NextResponse.json({
    requestId: data.id,
    status: data.status,
    progress: data.progress,
    result: shoppingListRequestResultForResponse(data.result),
  });
}

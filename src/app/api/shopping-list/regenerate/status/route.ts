import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { shoppingListRequestResultForResponse } from '@/lib/shopping-list-request-error';
import { API_NOT_FOUND_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { internalError } from '@/lib/api/errors';
import { isUuid } from '@/lib/http-params';


/** 400: 確かめる要求 (requestId) が無い */
const REQUEST_ID_REQUIRED_MESSAGE = '確認する要求 (requestId) を指定してください';

/**
 * 買い物リスト再生成リクエストのステータス確認API
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const requestId = searchParams.get('requestId');

  if (!requestId) {
    return NextResponse.json({ error: REQUEST_ID_REQUIRED_MESSAGE }, { status: 400 });
  }

  // UUID の形でない requestId は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)
  if (!isUuid(requestId)) {
    return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
  }

  const { data, error } = await supabase
    .from('shopping_list_requests')
    .select('id, status, progress, result')
    .eq('id', requestId)
    .eq('user_id', user.id)
    .maybeSingle();

  // 読めなかったときは 404 にしない (行が無いときだけ 404。一時的な失敗で要求が消えたように見せない。#1917)
  if (error) {
    return internalError('GET /api/shopping-list/regenerate/status', error, { userId: user.id, table: 'shopping_list_requests' });
  }
  if (!data) {
    return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
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

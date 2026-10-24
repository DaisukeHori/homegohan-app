import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { AI_CONSULTATION_SESSION_NOT_FOUND_MESSAGE, AI_CONSULTATION_MESSAGE_NOT_FOUND_MESSAGE, AI_CONSULTATION_IMPORTANT_LIST_MOVED_MESSAGE } from '@/lib/ai/ai-api-messages';
import { isUuid } from '@/lib/http-params';

// 重要マークのトグル
export async function POST(
  request: Request,
  props: { params: Promise<{ sessionId: string; messageId: string }> }
) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  try {
    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)
    if (!isUuid(params.sessionId)) {
      return NextResponse.json({ error: AI_CONSULTATION_SESSION_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    // セッション所有者確認。読めなかったときは 404 にしない (行が無い・他人のセッションのときだけ 404。#1917)
    const { data: session, error: sessionError } = await supabase
      .from('ai_consultation_sessions')
      .select('user_id')
      .eq('id', params.sessionId)
      .maybeSingle();

    if (sessionError) {
      return internalError('POST /api/ai/consultation/sessions/[sessionId]/messages/[messageId]/important', sessionError, { userId: user.id, table: 'ai_consultation_sessions' });
    }
    if (!session || session.user_id !== user.id) {
      return NextResponse.json({ error: AI_CONSULTATION_SESSION_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    // UUID の形でない messageId は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)
    if (!isUuid(params.messageId)) {
      return NextResponse.json({ error: AI_CONSULTATION_MESSAGE_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    // メッセージ確認。読めなかったときは 404 にしない (行が無いときだけ 404。#1917)
    const { data: message, error: messageError } = await supabase
      .from('ai_consultation_messages')
      .select('id, is_important, importance_reason')
      .eq('id', params.messageId)
      .eq('session_id', params.sessionId)
      .maybeSingle();

    if (messageError) {
      return internalError('POST /api/ai/consultation/sessions/[sessionId]/messages/[messageId]/important', messageError, { userId: user.id, table: 'ai_consultation_messages' });
    }
    if (!message) {
      return NextResponse.json({ error: AI_CONSULTATION_MESSAGE_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    const body = await request.json();
    const newImportantState = body.isImportant ?? !message.is_important;
    const reason = body.reason || null;

    // 重要フラグを更新
    const { error: updateError } = await supabase
      .from('ai_consultation_messages')
      .update({
        is_important: newImportantState,
        importance_reason: newImportantState ? reason : null,
      })
      .eq('id', params.messageId);

    if (updateError) throw updateError;

    return NextResponse.json({
      success: true,
      isImportant: newImportantState,
    });

  } catch (error: any) {
    return internalError('POST /api/ai/consultation/sessions/[sessionId]/messages/[messageId]/important', error, { userId: user.id });
  }
}

// 重要メッセージ一覧取得（セッション横断）
// パスの値 (params) は使わないので受け取らない。Next 15 の params は Promise で、以前の同期の型のままだと next build の
// 型検査で落ちる (#1444)
export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  // このエンドポイントは個別メッセージ用なので、一覧は別で実装
  return NextResponse.json({ error: AI_CONSULTATION_IMPORTANT_LIST_MOVED_MESSAGE }, { status: 400 });
}


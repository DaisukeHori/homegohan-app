import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// 重要マークのトグル
export async function POST(
  request: Request,
  { params }: { params: { sessionId: string; messageId: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // セッション所有者確認
    const { data: session } = await supabase
      .from('ai_consultation_sessions')
      .select('user_id')
      .eq('id', params.sessionId)
      .single();

    if (!session || session.user_id !== user.id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // メッセージ確認
    const { data: message } = await supabase
      .from('ai_consultation_messages')
      .select('id, is_important, importance_reason')
      .eq('id', params.messageId)
      .eq('session_id', params.sessionId)
      .single();

    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
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
    console.error('Important toggle error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// 重要メッセージ一覧取得（セッション横断）
export async function GET(
  request: Request,
  { params }: { params: { sessionId: string; messageId: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // このエンドポイントは個別メッセージ用なので、一覧は別で実装
  return NextResponse.json({ error: 'Use /api/ai/consultation/important-messages instead' }, { status: 400 });
}


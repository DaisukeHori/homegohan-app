import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// メッセージ一覧取得
export async function GET(
  request: Request,
  { params }: { params: { sessionId: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // セッション所有者確認
  const { data: session } = await supabase
    .from('ai_consultation_sessions')
    .select('user_id')
    .eq('id', params.sessionId)
    .single();

  if (!session || session.user_id !== user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { data, error } = await supabase
    .from('ai_consultation_messages')
    .select('*')
    .eq('session_id', params.sessionId)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const messages = (data || [])
    .filter((m: any) => !m.metadata?.isSystemPrompt)
    .map((m: any) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      proposedActions: m.proposed_actions,
      createdAt: m.created_at,
    }));

  return NextResponse.json({ messages });
}

// メッセージ送信（AI応答を含む）
export async function POST(
  request: Request,
  { params }: { params: { sessionId: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // セッション所有者確認
    const { data: session } = await supabase
      .from('ai_consultation_sessions')
      .select('*')
      .eq('id', params.sessionId)
      .single();

    if (!session || session.user_id !== user.id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const body = await request.json();
    const userMessage = body.message?.trim();

    if (!userMessage) {
      return NextResponse.json({ error: 'メッセージを入力してください' }, { status: 400 });
    }

    // ユーザーメッセージを保存
    const { data: savedUserMessage, error: userMsgError } = await supabase
      .from('ai_consultation_messages')
      .insert({
        session_id: params.sessionId,
        role: 'user',
        content: userMessage,
      })
      .select()
      .single();

    if (userMsgError) throw userMsgError;

    // 過去のメッセージを取得
    const { data: historyData } = await supabase
      .from('ai_consultation_messages')
      .select('role, content')
      .eq('session_id', params.sessionId)
      .order('created_at', { ascending: true })
      .limit(20);

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = (historyData || []).map((m: any) => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    }));

    // OpenAI APIで応答生成
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.7,
      max_tokens: 1500,
    });

    const aiContent = completion.choices[0]?.message?.content || 'すみません、応答を生成できませんでした。';

    // アクション提案を抽出
    const actionMatch = aiContent.match(/```action\s*([\s\S]*?)```/);
    let proposedActions = null;
    if (actionMatch) {
      try {
        proposedActions = JSON.parse(actionMatch[1]);
      } catch (e) {
        console.error('Failed to parse action:', e);
      }
    }

    // AI応答を保存
    const { data: savedAiMessage, error: aiMsgError } = await supabase
      .from('ai_consultation_messages')
      .insert({
        session_id: params.sessionId,
        role: 'assistant',
        content: aiContent.replace(/```action[\s\S]*?```/g, '').trim(),
        proposed_actions: proposedActions,
        tokens_used: completion.usage?.total_tokens,
      })
      .select()
      .single();

    if (aiMsgError) throw aiMsgError;

    // アクションがある場合はai_action_logsに記録
    if (proposedActions) {
      await supabase
        .from('ai_action_logs')
        .insert({
          session_id: params.sessionId,
          message_id: savedAiMessage.id,
          action_type: proposedActions.type,
          action_params: proposedActions.params || {},
          status: 'pending',
        });
    }

    // セッションのupdated_atを更新
    await supabase
      .from('ai_consultation_sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', params.sessionId);

    return NextResponse.json({
      success: true,
      userMessage: {
        id: savedUserMessage.id,
        role: 'user',
        content: userMessage,
        createdAt: savedUserMessage.created_at,
      },
      aiMessage: {
        id: savedAiMessage.id,
        role: 'assistant',
        content: savedAiMessage.content,
        proposedActions,
        createdAt: savedAiMessage.created_at,
      },
    });

  } catch (error: any) {
    console.error('Message error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}


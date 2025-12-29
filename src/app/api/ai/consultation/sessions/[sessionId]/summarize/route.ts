import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';

function getOpenAI(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY');
  }
  return new OpenAI({ apiKey });
}

// セッション要約を生成
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

    // セッションの全メッセージを取得
    const { data: messages } = await supabase
      .from('ai_consultation_messages')
      .select('role, content, created_at, is_important')
      .eq('session_id', params.sessionId)
      .order('created_at', { ascending: true });

    if (!messages || messages.length === 0) {
      return NextResponse.json({ error: 'メッセージがありません' }, { status: 400 });
    }

    // 重要マークされたメッセージを抽出
    const importantMessages = messages.filter((m: any) => m.is_important);

    // 会話内容を整形
    const conversationText = messages
      .filter((m: any) => m.role !== 'system')
      .map((m: any) => `[${m.role === 'user' ? 'ユーザー' : 'AI'}] ${m.content}`)
      .join('\n\n');

    // AIに要約を依頼
    const summaryPrompt = `以下の会話を要約してください。

【要約ルール】
1. 固有名詞（人名、店名、商品名、料理名など）は必ず保持
2. 数値・定量的な情報（体重、カロリー、日数、金額など）は日付とともに箇条書きで記載
3. 決定事項・約束事項は明確に記載
4. 実行されたアクション（献立作成、目標設定など）を記載
5. ユーザーの好み・傾向で新たに判明したことを記載
6. その他の内容は簡潔に要約

【出力形式】
以下のJSON形式で出力してください：
{
  "title": "セッションの簡潔なタイトル（15文字以内）",
  "summary": "会話の概要（200文字以内）",
  "key_facts": [
    {
      "date": "YYYY-MM-DD または null",
      "category": "体重|カロリー|目標|決定事項|好み|その他",
      "content": "具体的な内容"
    }
  ],
  "key_topics": ["トピック1", "トピック2"],
  "actions_taken": ["実行されたアクション1", "アクション2"],
  "user_insights": ["ユーザーについて新たに分かったこと"]
}

【会話内容】
${conversationText}

${importantMessages.length > 0 ? `
【ユーザーが重要とマークしたメッセージ】
${importantMessages.map((m: any) => `- ${m.content.substring(0, 200)}`).join('\n')}
` : ''}`;

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: 'あなたは会話を正確に要約するアシスタントです。JSONのみを出力してください。' },
        { role: 'user', content: summaryPrompt },
      ],
      temperature: 0.3,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
    });

    const summaryContent = completion.choices[0]?.message?.content;
    if (!summaryContent) {
      throw new Error('要約の生成に失敗しました');
    }

    const summaryData = JSON.parse(summaryContent);

    // セッションを更新
    const { error: updateError } = await supabase
      .from('ai_consultation_sessions')
      .update({
        title: summaryData.title || session.title,
        summary: summaryData.summary,
        key_topics: summaryData.key_topics || [],
        action_history: [
          ...(session.action_history || []),
          ...(summaryData.actions_taken || []).map((action: string) => ({
            action,
            date: new Date().toISOString(),
          })),
        ],
        summary_generated_at: new Date().toISOString(),
        // key_factsはsummaryに含めて保存（後で参照しやすいように）
        context_snapshot: {
          ...session.context_snapshot,
          key_facts: summaryData.key_facts,
          user_insights: summaryData.user_insights,
        },
      })
      .eq('id', params.sessionId);

    if (updateError) throw updateError;

    return NextResponse.json({
      success: true,
      summary: summaryData,
    });

  } catch (error: any) {
    console.error('Summary generation error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

